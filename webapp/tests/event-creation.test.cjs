const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const dateFns = require('date-fns');
const root = path.join(__dirname, '../src/components');
const transpile = source => ts.transpileModule(source, {compilerOptions: {target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS}}).outputText;
function load(file, mocks = {}) {
    const module = {exports: {}};
    vm.runInNewContext(transpile(fs.readFileSync(path.join(root, file), 'utf8')), {module, exports: module.exports, Intl, Date, require: name => mocks[name] || require(name)});
    return module.exports;
}
const agenda = load('calendar-agenda.ts');
const {newEventTime} = load('new-event-time.ts', {'./calendar-agenda': agenda});
const callbacks = [];
let opening;
for (const file of ['event.tsx', 'calendar-content.tsx']) {
    const source = ts.createSourceFile(file, fs.readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    function visit(node) {
        if (ts.isVariableDeclaration(node) && ['defaultTypeForCalendar', 'isCallType', 'applyTypeDefaults', 'cleanState', 'onDateTimeSelected', 'buildDateTime', 'onAllDayToggle'].includes(node.name.getText(source))) callbacks.push(`const ${node.getText(source)};`);
        if (ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect' && node.arguments[1]?.getText(source) === '[isOpenEventModal]') opening = node.arguments[0].getText(source);
        ts.forEachChild(node, visit);
    }
    visit(source);
}
const code = transpile(`${callbacks.join('\n')}\nglobalThis.handlers = {select: onDateTimeSelected, open: ${opening}, toggleAllDay: onAllDayToggle};`);
const fixedNow = new Date('2026-10-30T09:17:12Z');
function form(type = 'call', instant = fixedNow, zone = 'Europe/Moscow') {
    const ctx = {
        ...dateFns, newEventTime, agendaTimeZone: agenda.agendaTimeZone,
        Date: class extends Date {constructor(...args) {super(...(args.length ? args : [instant]));}},
        currentUser: {timezone: {manualTimezone: zone}}, selectedCalendarType: type,
        EVENT_TYPE_CALL: 'call', EVENT_TYPE_EVENT: 'event', EVENT_ALERT_AT_START_TIME: 'at_start_time', DEFAULT_MENTION: '', DEFAULT_VISIBILITY: 'team',
        selectedEvent: {}, isOpenEventModal: true, selectedAllDay: false, selectedType: 'call',
        allDayTouchedRef: {current: false}, alertTouchedRef: {current: false},
        userSearchRequest: {current: 0}, channelSearchRequest: {current: 0}, channelMembersRequest: {current: 0}, channelMembersLoading: {current: false},
        eventSelected: payload => ({type: 'selected', payload}), openEventModal: () => ({type: 'open'}),
        updateSelectedEventTime: payload => ({type: 'time', payload}), updateMembersAddedInEvent: payload => ({type: 'members', payload}),
    };
    ctx.dispatch = action => {
        if (action.type === 'selected') ctx.selectedEvent = action.payload;
        if (action.type === 'open') ctx.isOpenEventModal = true;
        if (action.type === 'time') ctx.selectedEventTime = {...ctx.selectedEventTime, ...action.payload};
        if (action.type === 'members') ctx.members = action.payload;
    };
    for (const [setter, key] of Object.entries({setSelectedAllDay: 'selectedAllDay', setSelectedAlert: 'alert', setSelectedType: 'selectedType'})) ctx[setter] = value => {ctx[key] = value;};
    for (const setter of ['setTitleEvent', 'setDescriptionEvent', 'setIsSaving', 'setIsLoading', 'setIsLoadingChannelMembers', 'setUsersAutocomplete', 'setChannelsAutocomplete', 'setSelectedChannelText', 'setSelectedChannel', 'setSearchUsersInput', 'setShowCustomRepeat', 'setRepeatOptionsSelected', 'setRepeatOption', 'setRepeatRule', 'setMeetingLink', 'setEventOwner', 'setSelectedMention', 'setSelectedVisibility']) ctx[setter] = () => {};
    vm.runInNewContext(code, ctx);
    return ctx;
}
function click(ctx, startStr = '2026-11-03', endStr = '2026-11-04', allDay = true) {
    const selection = {startStr, endStr, allDay, start: new Date(startStr), end: new Date(endStr)};
    const before = [selection.start.getTime(), selection.end.getTime()];
    ctx.handlers.select(selection);
    assert.deepEqual([selection.start.getTime(), selection.end.getTime()], before, 'FullCalendar dates must not be mutated');
    ctx.handlers.open();
}
function summary(ctx) {
    const time = ctx.selectedEventTime;
    return {start: dateFns.format(time.start, 'yyyy-MM-dd'), end: dateFns.format(time.end, 'yyyy-MM-dd'), startTime: time.startTime, endTime: time.endTime, allDay: ctx.selectedAllDay, alert: ctx.alert, type: ctx.selectedType};
}

test('day cell and Create use the same Call defaults, keeping the selected day', () => {
    const create = form(); create.handlers.open();
    const cell = form(); click(cell);
    assert.deepEqual(summary(cell), {...summary(create), start: '2026-11-03', end: '2026-11-03'});
    assert.equal(cell.selectedEventTime.startTime, '12:30');
    assert.equal(cell.selectedEventTime.endTime, '13:00');
    assert.equal(cell.selectedAllDay, false);
    assert.equal(cell.alert, 'at_start_time');
    assert.equal(cell.selectedType, 'call');
});
test('Event from a day cell defaults to all day on that day, without including tomorrow', () => {
    const create = form('event'); create.handlers.open();
    const cell = form('event'); click(cell);
    assert.deepEqual(summary(cell), {...summary(create), start: '2026-11-03', end: '2026-11-03'});
    assert.equal(cell.selectedAllDay, true);
    assert.equal(cell.alert, '');
});
test('a timed cell also uses the current half-hour defaults instead of the cell clock', () => {
    const ctx = form(); click(ctx, '2026-11-03T15:00:00+03:00', '2026-11-03T15:30:00+03:00', false);
    assert.equal(ctx.selectedEventTime.startTime, '12:30');
    assert.equal(dateFns.format(ctx.selectedEventTime.start, 'yyyy-MM-dd'), '2026-11-03');
});
test('opening a new form resets previous all-day and alert overrides', () => {
    const ctx = form('event'); ctx.selectedAllDay = false; ctx.allDayTouchedRef.current = true; ctx.alertTouchedRef.current = true;
    click(ctx);
    assert.equal(ctx.selectedAllDay, true);
    assert.equal(ctx.allDayTouchedRef.current, false);
    assert.equal(ctx.alertTouchedRef.current, false);
});
test('the combined calendar uses Call defaults for a new event', () => {
    const ctx = form('all'); click(ctx);
    assert.equal(ctx.selectedType, 'call');
    assert.equal(ctx.selectedAllDay, false);
    assert.equal(ctx.alert, 'at_start_time');
});
test('the creation defaults do not overwrite an existing event', () => {
    const ctx = form(); ctx.selectedEvent = {event: {id: 'saved'}}; ctx.selectedEventTime = {sentinel: true};
    ctx.handlers.open();
    assert.deepEqual(ctx.selectedEventTime, {sentinel: true});
});
test('rounding stays at exact boundaries, rounds fractional seconds up and keeps 30 minutes', () => {
    for (const [instant, expected] of [['2026-10-30T09:00:00Z', '12:00'], ['2026-10-30T09:00:00.001Z', '12:30'], ['2026-10-30T09:15:00Z', '12:30'], ['2026-10-30T09:30:00Z', '12:30']]) {
        const time = newEventTime(new Date(instant), 'Europe/Moscow');
        assert.equal(time.startTime, expected);
        assert.equal(time.end.getTime() - time.start.getTime(), 30 * 60000);
    }
});
test('midnight rollover uses the Mattermost date; all-day defaults stay on one day', () => {
    const time = newEventTime(new Date('2026-10-30T20:50:00Z'), 'Europe/Moscow');
    assert.equal(dateFns.format(time.start, 'yyyy-MM-dd'), '2026-10-31');
    assert.equal(time.startTime, '00:00');
    assert.equal(time.endTime, '00:30');
    const ctx = form('event', new Date('2026-10-30T20:17:00Z')); click(ctx);
    assert.equal(summary(ctx).start, summary(ctx).end);
    ctx.handlers.toggleAllDay(false);
    assert.equal(dateFns.format(ctx.selectedEventTime.end, 'yyyy-MM-dd'), '2026-11-04');
});
test('negative timezone offsets preserve the clicked day from startStr', () => {
    const ctx = form('call', fixedNow, 'America/Los_Angeles');
    click(ctx, '2026-11-03T23:30:00-08:00', '2026-11-04T00:00:00-08:00', false);
    assert.equal(summary(ctx).start, '2026-11-03');
    assert.equal(summary(ctx).startTime, '02:30');
});
