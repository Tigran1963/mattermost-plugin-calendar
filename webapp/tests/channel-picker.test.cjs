const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Run the modal's actual callbacks with state/store/HTTP boundaries supplied by
// a harness, without requiring Mattermost's unavailable application test setup.
const source = ts.createSourceFile('event.tsx', fs.readFileSync(process.env.CALENDAR_EVENT_SOURCE || path.join(__dirname, '../src/components/event.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const callbacks = [];
const names = ['notArchived', 'loadMyChannels', 'onInputChannelAction', 'onSelectChannelOption', 'chooseAllUsersFromChannel', 'cleanState', 'parseEventDate'];
let selectUser, teamEffect, bulkDisabled = 'false';
function visit(node) {
    if (ts.isVariableDeclaration(node) && names.includes(node.name.getText(source))) callbacks.push(`const ${node.getText(source)};`);
    if (ts.isJsxOpeningElement(node) && node.attributes.properties.some(attr => attr.name?.text === 'placeholder' && attr.initializer?.text === 'Select a user')) selectUser = node.attributes.properties.find(attr => attr.name?.text === 'onOptionSelect').initializer.expression.getText(source);
    if (ts.isJsxOpeningElement(node) && node.attributes.properties.some(attr => attr.name?.text === 'className' && attr.initializer?.text === 'event-channel-users-action')) bulkDisabled = node.attributes.properties.find(attr => attr.name?.text === 'disabled')?.initializer.expression.getText(source) || 'false';
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect' && node.arguments[1]?.getText(source) === '[teamId, isEditingEvent]') teamEffect = node.arguments[0].getText(source);
    ts.forEachChild(node, visit);
}
visit(source);
const code = ts.transpileModule(`${callbacks.join('\n')}\nglobalThis.handlers = {loadMyChannels, onInputChannelAction, onSelectChannelOption, cleanState, parseEventDate, selectUser: ${selectUser}, teamEffect: ${teamEffect}, bulkDisabled: () => ${bulkDisabled}};`, {compilerOptions: {target: ts.ScriptTarget.ES2020}}).outputText;
const active = {id: 'active', display_name: 'Active', type: 'O', delete_at: 0};
const other = {id: 'other', display_name: 'Other', type: 'P', delete_at: 0};
const archived = {id: 'archived', type: 'O', delete_at: 123};
const member = {id: 'member', delete_at: 0}, inactive = {id: 'inactive', delete_at: 123};
const deferred = () => {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};};
function setup(client = {}) {
    const ctx = {
        parse: require('date-fns/parse'),
        isEditingEvent: false, teamId: 'team', channelsAutocomplete: [], selectedChannel: {}, selectedChannelText: '',
        channelSearchRequest: {current: 0}, channelMembersRequest: {current: 0}, channelMembersLoading: {current: false},
        userSearchRequest: {current: 0}, usersAddedInEventRef: {current: []}, usersAddedInEvent: [],
        isLoadingChannelMembers: false, usersAutocomplete: [], profilesInChannel: [], usersMentionTags: {'@channel': 'Choose all users from channel'},
        Client4: {getMyChannels: async () => [active, other, archived], autocompleteChannels: async () => [active, archived], getProfilesInChannel: async () => [member, inactive], ...client},
        getProfilesInChannel: () => ({}), errors: [], showErrorToast: message => ctx.errors.push(message),
        dispatch: action => {if (action?.type === 'members') {ctx.usersAddedInEvent = action.members; ctx.usersAddedInEventRef.current = action.members;}},
        updateMembersAddedInEvent: members => ({type: 'members', members}), updateSelectedEventTime: () => ({}),
        selectedCalendarType: 'call', defaultTypeForCalendar: () => 'call', applyTypeDefaults: () => {},
        alertTouchedRef: {}, allDayTouchedRef: {}, initialDate: new Date(), initialStartTime: () => '', initialEndTime: () => '', DEFAULT_MENTION: '', DEFAULT_VISIBILITY: 'team',
    };
    for (const [setter, key] of Object.entries({setChannelsAutocomplete: 'channelsAutocomplete', setSelectedChannel: 'selectedChannel', setSelectedChannelText: 'selectedChannelText', setIsLoadingChannelMembers: 'isLoadingChannelMembers', setUsersAutocomplete: 'usersAutocomplete'})) ctx[setter] = value => {ctx[key] = value;};
    for (const name of ['setTitleEvent', 'setDescriptionEvent', 'setIsSaving', 'setIsLoading', 'setSearchUsersInput', 'setShowCustomRepeat', 'setRepeatOptionsSelected', 'setRepeatOption', 'setRepeatRule', 'setMeetingLink', 'setEventOwner', 'setSelectedMention', 'setSelectedVisibility', 'setSelectedType']) ctx[name] = () => {};
    vm.runInNewContext(code, ctx);
    return ctx;
}
const ids = users => Array.from(users, user => user.id);
const type = (ctx, value) => ctx.handlers.onInputChannelAction({target: {value}});
const choose = ctx => ctx.handlers.selectUser({}, {optionValue: '@channel'});
function select(ctx, channel = active) {ctx.channelsAutocomplete = [channel]; ctx.handlers.onSelectChannelOption({}, {optionValue: channel.id});}

test('late opening response cannot overwrite a typed search', async () => {
    const mine = deferred(), ctx = setup({getMyChannels: () => mine.promise});
    const opening = ctx.handlers.loadMyChannels(); await type(ctx, 'act'); mine.resolve([other]); await opening;
    assert.deepEqual(ids(ctx.channelsAutocomplete), ['active']);
});
test('late failed search cannot erase a newer success', async () => {
    const old = deferred(), ctx = setup({autocompleteChannels: (_, query) => query === 'old' ? old.promise : Promise.resolve([other])});
    const pending = type(ctx, 'old'); await type(ctx, 'new'); old.reject(Error('network')); await pending;
    assert.deepEqual(ids(ctx.channelsAutocomplete), ['other']);
});
test('clearing input restores active own channels and invalidates old search', async () => {
    const old = deferred(), ctx = setup({autocompleteChannels: () => old.promise});
    const pending = type(ctx, 'old'); await type(ctx, ''); old.resolve([archived]); await pending;
    assert.deepEqual(ids(ctx.channelsAutocomplete), ['active', 'other']);
});
test('reset discards pending channel replies', async () => {
    const old = deferred(), ctx = setup({getMyChannels: () => old.promise});
    const pending = ctx.handlers.loadMyChannels(); ctx.handlers.cleanState(); old.resolve([active]); await pending;
    assert.deepEqual(ids(ctx.channelsAutocomplete), []);
});
test('bulk selection is disabled without a channel and while its request runs', async () => {
    const pending = deferred(), ctx = setup({getProfilesInChannel: () => pending.promise});
    assert.equal(ctx.handlers.bulkDisabled(), true); await choose(ctx); assert.deepEqual(ids(ctx.usersAddedInEvent), []);
    select(ctx); const request = choose(ctx); assert.equal(ctx.handlers.bulkDisabled(), true);
    pending.resolve([member]); await request; assert.equal(ctx.handlers.bulkDisabled(), false);
});
test('bulk selection fetches selected channel, filters inactive and merges existing users', async () => {
    let args; const ctx = setup({getProfilesInChannel: async (...input) => {args = input; return [member, inactive, member];}});
    ctx.usersAddedInEventRef.current = [{id: 'manual', delete_at: 0}, member]; select(ctx); await choose(ctx);
    assert.equal(args[0], active.id); assert.equal(args[1], 0); assert.equal(args[2], 1000);
    assert.deepEqual(ids(ctx.usersAddedInEvent), ['manual', 'member']);
});
test('changing channel while fetching members discards the old result', async () => {
    const pending = deferred(), ctx = setup({getProfilesInChannel: () => pending.promise});
    select(ctx); const request = choose(ctx); select(ctx, other); pending.resolve([member]); await request;
    assert.deepEqual(ids(ctx.usersAddedInEvent), []); assert.equal(ctx.isLoadingChannelMembers, false);
});
test('typing another channel clears the previous selection', async () => {
    const ctx = setup(); select(ctx); await type(ctx, 'another');
    assert.equal(ctx.selectedChannel.id, undefined); assert.equal(ctx.handlers.bulkDisabled(), true);
});
test('failed member load preserves existing attendees and shows an error', async () => {
    const ctx = setup({getProfilesInChannel: async () => {throw Error('network');}});
    ctx.usersAddedInEvent = ctx.usersAddedInEventRef.current = [member]; select(ctx); await choose(ctx);
    assert.deepEqual(ids(ctx.usersAddedInEvent), ['member']); assert.equal(ctx.errors.length, 1); assert.equal(ctx.isLoadingChannelMembers, false);
});
test('manual additions made during a member request are preserved', async () => {
    const pending = deferred(), ctx = setup({getProfilesInChannel: () => pending.promise});
    select(ctx); const request = choose(ctx); ctx.usersAddedInEventRef.current = [{id: 'added-while-loading'}]; pending.resolve([member]); await request;
    assert.deepEqual(ids(ctx.usersAddedInEvent), ['added-while-loading', 'member']);
});

test('team changes invalidate both channel options and pending member responses', async () => {
    const options = deferred(), members = deferred();
    const ctx = setup({getMyChannels: () => options.promise, getProfilesInChannel: () => members.promise});
    select(ctx); const adding = choose(ctx), opening = ctx.handlers.loadMyChannels();
    ctx.teamId = 'another-team'; ctx.handlers.teamEffect();
    members.resolve([member]); options.resolve([active]); await Promise.all([adding, opening]);
    assert.deepEqual(ids(ctx.usersAddedInEvent), []); assert.deepEqual(ids(ctx.channelsAutocomplete), []);
    assert.equal(ctx.selectedChannel.id, undefined); assert.equal(ctx.isLoadingChannelMembers, false);
});
test('repeated bulk clicks start a single request', async () => {
    let requests = 0; const pending = deferred();
    const ctx = setup({getProfilesInChannel: () => {requests++; return pending.promise;}});
    select(ctx); const first = choose(ctx), second = choose(ctx);
    assert.equal(requests, 1); pending.resolve([member]); await Promise.all([first, second]);
    assert.deepEqual(ids(ctx.usersAddedInEvent), ['member']);
});

test('all-day date editing preserves local date in a negative UTC offset', () => {
    const before = process.env.TZ;
    try {
        process.env.TZ = 'America/Los_Angeles';
        const ctx = setup();
        const date = ctx.handlers.parseEventDate('2026-10-23', true);
        assert.equal(date.getFullYear(), 2026); assert.equal(date.getMonth(), 9);
        assert.equal(date.getDate(), 23); assert.equal(date.getHours(), 0);
        const timed = ctx.handlers.parseEventDate('2026-10-23T21:00:00+03:00', false);
        assert.equal(timed.toISOString(), '2026-10-23T18:00:00.000Z');
    } finally {
        if (before === undefined) delete process.env.TZ; else process.env.TZ = before;
    }
});

test('late team fallback preserves an existing event channel while invalidating old requests', async () => {
    const options = deferred(), members = deferred();
    const ctx = setup({getMyChannels: () => options.promise, getProfilesInChannel: () => members.promise});
    ctx.isEditingEvent = true;
    select(ctx); const adding = choose(ctx), opening = ctx.handlers.loadMyChannels();
    ctx.teamId = 'resolved-team'; ctx.handlers.teamEffect();
    members.resolve([member]); options.resolve([other]); await Promise.all([adding, opening]);
    assert.equal(ctx.selectedChannel.id, active.id); assert.equal(ctx.selectedChannelText, active.display_name);
    assert.deepEqual(ids(ctx.usersAddedInEvent), []); assert.deepEqual(ids(ctx.channelsAutocomplete), []);
    assert.equal(ctx.isLoadingChannelMembers, false);
});
