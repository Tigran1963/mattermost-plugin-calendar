const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.join(__dirname, '../src');
function load(file, mocks = {}, globals = {}) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const code = ts.transpileModule(source, {compilerOptions: {jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true}}).outputText;
    const module = {exports: {}};
    vm.runInNewContext(code, {module, exports: module.exports, URLSearchParams, AbortController, Intl, Date, require: name => name in mocks ? mocks[name] : require(name), ...globals}, {filename: file});
    return module.exports;
}
const agenda = load('components/calendar-agenda.ts');
const now = new Date('2026-10-30T09:00:00Z');
const event = (id, start, end, extra = {}) => ({id, title: id, start, end, type: 'call', ...extra});
const upcoming = event('call', '2026-10-30T12:00:00Z', '2026-10-30T13:00:00Z');
const wholeDay = event('all-day', '2026-10-30', '2026-10-31', {type: 'event', allDay: true});
const plain = value => JSON.parse(JSON.stringify(value));

test('Mattermost manual string false and automatic booleans resolve explicitly', () => {
    assert.equal(agenda.agendaTimeZone({useAutomaticTimezone: 'false', manualTimezone: 'Europe/Moscow', automaticTimezone: 'America/Los_Angeles'}), 'Europe/Moscow');
    assert.equal(agenda.agendaTimeZone({useAutomaticTimezone: true, manualTimezone: 'UTC', automaticTimezone: 'Europe/Moscow'}), 'Europe/Moscow');
    assert.doesNotThrow(() => agenda.agendaTimeZone({manualTimezone: 'not/a-zone'}));
});
test('request range is seven calendar days in user timezone, even over DST', () => {
    assert.deepEqual(plain(agenda.agendaRange(new Date('2026-10-30T23:00:00Z'), 'Europe/Moscow')), {start: '2026-10-31T00:00:00', end: '2026-11-07T00:00:00'});
    assert.deepEqual(plain(agenda.agendaRange(now, 'America/New_York')), {start: '2026-10-30T00:00:00', end: '2026-11-06T00:00:00'});
});
test('all-day DATE stays on its date in a negative offset and end is exclusive', () => {
    const days = agenda.buildAgenda([wholeDay, {...wholeDay, id: 'expired', start: '2026-10-29', end: '2026-10-30'}], now, 'America/Los_Angeles');
    assert.equal(days[0].date, '2026-10-30');
    assert.equal(days[0].items.length, 1);
    assert.equal(days[0].items[0].time, 'All day');
});
test('agenda sorts all-day first and timed events chronologically, excluding finished events', () => {
    const events = [upcoming, wholeDay, event('earlier', '2026-10-30T10:00:00Z', '2026-10-30T11:00:00Z'), event('finished', '2026-10-30T07:00:00Z', '2026-10-30T08:00:00Z')];
    const days = agenda.buildAgenda(events, now, 'Europe/Moscow');
    assert.deepEqual(plain(days[0].items.map(item => item.event.id)), ['all-day', 'earlier', 'call']);
    assert.equal(days[0].label, 'Today');
    assert.match(days[0].items[2].time, /15:00/);
});
test('multi-day and ongoing events stay visible today, horizon is exclusive', () => {
    const values = [event('ongoing', '2026-10-29T20:00:00Z', '2026-10-30T12:00:00Z'), event('long', '2026-10-29', '2026-11-03', {allDay: true}), event('outside', '2026-11-06T12:00:00Z', '2026-11-06T13:00:00Z')];
    const days = agenda.buildAgenda(values, now, 'Europe/Moscow');
    assert.equal(days.length, 1);
    assert.equal(days[0].date, '2026-10-30');
    assert.equal(days[0].items.find(item => item.event.id === 'ongoing').ongoing, true);
    assert.match(days[0].items.find(item => item.event.id === 'long').time, /until/);
});
test('calls, events and recurring occurrences remain visible without truncating a busy day', () => {
    const events = Array.from({length: 100}, (_, index) => ({...upcoming, id: String(index)}));
    events.push(wholeDay, {...upcoming, start: '2026-10-31T12:00:00Z', end: '2026-10-31T13:00:00Z'});
    const days = agenda.buildAgenda(events, now, 'UTC');
    assert.equal(days[0].items.length, 101);
    assert.equal(days[1].label, 'Tomorrow');
    assert.equal(days[1].items[0].event.id, upcoming.id);
    assert.equal(days[0].items[0].event.id, 'all-day');
    assert.equal(agenda.buildAgenda([event('bad', 'invalid', 'invalid')], now, 'UTC').length, 0);
});

function client(fetch) {
    return load('client.tsx', {'mattermost-redux/client': {Client4: {getOptions: options => ({credentials: 'include', ...options})}}, 'components/utils': () => 'https://example.com/subpath', './manifest': {id: 'calendar'}}, {fetch}).ApiClient;
}
test('agenda API preserves credentials, subpath, range and cancellation', async () => {
    let request;
    const api = client(async (...args) => {request = args; return {ok: true, json: async () => ({data: [upcoming]})};});
    const controller = new AbortController();
    const response = await api.getEvents('2026-10-30T00:00:00', '2026-11-06T00:00:00', controller.signal);
    const url = new URL(request[0]);
    assert.equal(url.pathname, '/subpath/plugins/calendar/events');
    assert.equal(url.searchParams.get('start'), '2026-10-30T00:00:00');
    assert.equal(request[1].signal, controller.signal);
    assert.equal(request[1].credentials, 'include');
    assert.equal(response.data[0].id, 'call');
});
test('API normalizes legacy null but rejects errors and malformed success data', async () => {
    assert.equal((await client(async () => ({ok: true, json: async () => ({data: null})})).getEvents('a', 'b')).data.length, 0);
    await assert.rejects(client(async () => ({ok: true, json: async () => ({data: {}})})).getEvents('a', 'b'), /Unexpected/);
    await assert.rejects(client(async () => ({ok: false, status: 403, statusText: 'Forbidden', clone: () => ({json: async () => ({message: 'No access'})})})).getEvents('a', 'b'), /No access/);
});

function frame(getEvents = async () => ({data: [wholeDay, upcoming]}), pathname = '/team/channels/town-square') {
    const values = [], effects = [], listeners = new Map(), actions = [], routes = [];
    let cursor = 0, writes = 0;
    const dispatch = action => actions.push(action);
    const state = {user: {id: 'user', timezone: {manualTimezone: 'Europe/Moscow'}}, settings: {callColor: '#663399', eventColor: '#ff8800'}, open: false};
    const React = {
        createElement: (type, props, ...children) => ({type, props: {...props, children}}),
        useState: initial => {const i = cursor++; if (!(i in values)) values[i] = initial; return [values[i], next => {writes++; values[i] = typeof next === 'function' ? next(values[i]) : next;}];},
        useRef: initial => {const i = cursor++; if (!(i in values)) values[i] = {current: initial}; return values[i];},
        useEffect: fn => effects.push(fn),
    };
    const action = type => payload => ({type, payload});
    const component = load('components/calendar-sidebar.tsx', {
        react: React,
        'react-redux': {useDispatch: () => dispatch, useSelector: key => state[key]},
        'react-router-dom': {useHistory: () => ({push: route => routes.push(route)}), useLocation: () => ({pathname})},
        'mattermost-redux/selectors/entities/users': {getCurrentUser: 'user'},
        '@fluentui/react-components': {Button: 'button', FluentProvider: 'FluentProvider', webLightTheme: {}},
        '@fluentui/react-icons': new Proxy({}, {get: (_, key) => key}),
        '../client': {ApiClient: {getEvents}},
        '../selectors': {getCalendarSettings: 'settings', selectIsOpenEventModal: 'open'},
        '../actions': Object.fromEntries(['closeEventModal', 'eventSelected', 'openEventModal', 'updateMembersAddedInEvent', 'updateSelectedEventTime'].map(name => [name, action(name)])),
        './event': 'EventModal', './calendar-agenda': agenda, './calendar-sidebar.css': {},
    }, {Date: class extends Date {constructor(value) {super(value === undefined ? now : value);}}, window: {setInterval: fn => {listeners.set('interval', fn); return 1;}, clearInterval: () => listeners.delete('interval'), addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name)}}).default;
    return {values, effects, listeners, actions, routes, state, get writes() {return writes;}, render() {cursor = 0; return component({onOpenCalendar: () => routes.push('hide')});}};
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {let resolve, reject; const promise = new Promise((a, b) => {resolve = a; reject = b;}); return {promise, resolve, reject};};
function nodes(node) {if (!node || typeof node !== 'object') return []; return [node, ...(node.props?.children || []).flat(Infinity).flatMap(nodes)];}
function text(node) {if (typeof node === 'string') return node; return (node?.props?.children || []).flat(Infinity).map(text).join('');}

test('sidebar fetches real agenda, displays configured colors and opens existing event in place', async () => {
    const page = frame(); page.render(); page.effects.forEach(fn => fn()); await tick();
    const tree = page.render();
    assert.equal(nodes(tree).filter(node => node.props.className === 'calendar-sidebar-event').length, 2);
    assert.equal(nodes(tree).some(node => node.props['aria-label'] === 'Calendar type'), false);
    const card = nodes(tree).find(node => node.props.className === 'calendar-sidebar-event' && text(node).includes('call'));
    assert.ok(card);
    assert.ok(nodes(card).some(node => node.props.style?.backgroundColor === '#663399'));
    card.props.onClick();
    assert.equal(page.actions.at(-2).payload.event.id, 'call');
    assert.equal(page.actions.at(-1).type, 'openEventModal');
    assert.deepEqual(page.routes, []);
});
test('sidebar ignores a late response after unmount and releases refresh listeners', async () => {
    const pending = deferred(), page = frame(() => pending.promise);
    page.render(); const cleanup = page.effects.map(fn => fn()).filter(fn => typeof fn === 'function');
    const before = page.writes; cleanup.forEach(fn => fn());
    pending.resolve({data: [upcoming]}); await tick();
    assert.equal(page.writes, before);
    assert.equal(page.listeners.size, 0);
});
test('focus refresh cancels older request and keeps newest result', async () => {
    const pending = deferred(); let count = 0, firstSignal;
    const page = frame((_, __, signal) => {if (!count++) {firstSignal = signal; return pending.promise;} return Promise.resolve({data: [wholeDay]});});
    page.render(); page.effects.forEach(fn => fn()); page.listeners.get('focus')(); await tick();
    pending.resolve({data: [upcoming]}); await tick();
    assert.equal(firstSignal.aborted, true);
    assert.equal(page.values[0][0].id, 'all-day');
});
test('error shows retry rather than claiming empty calendar', async () => {
    const page = frame(async () => {throw Error('offline');}); page.render(); page.effects.forEach(fn => fn()); await tick();
    const tree = page.render();
    assert.ok(nodes(tree).some(node => node.props.role === 'alert'));
    assert.match(text(tree), /Try again/);
    assert.doesNotMatch(text(tree), /Nothing scheduled/);
});
test('create and full-calendar controls preserve channels context until navigation', () => {
    const page = frame(); let tree = page.render();
    nodes(tree).find(node => node.type === 'button' && text(node) === 'Create').props.onClick();
    assert.deepEqual(page.actions.map(action => action.type), ['eventSelected', 'openEventModal']);
    assert.equal(page.routes.length, 0);
    page.state.open = true; tree = page.render();
    assert.equal(nodes(tree).filter(node => node.type === 'EventModal').length, 1);
    nodes(tree).find(node => node.type === 'button' && text(node) === 'Open calendar').props.onClick();
    assert.deepEqual(page.routes, ['hide', '/calendar']);
    const product = frame(undefined, '/calendar'); product.state.open = true;
    assert.equal(nodes(product.render()).filter(node => node.type === 'EventModal').length, 0, 'the full calendar already has an editor');
});

test('closing sidebar releases its owned editor and clears selection', () => {
    const page = frame(); const tree = page.render();
    const cleanup = page.effects.map(fn => fn()).filter(fn => typeof fn === 'function');
    nodes(tree).find(node => node.type === 'button' && text(node) === 'Create').props.onClick();
    cleanup.forEach(fn => fn());
    assert.deepEqual(page.actions.slice(-2).map(action => action.type), ['closeEventModal', 'eventSelected']);
    assert.deepEqual(plain(page.actions.at(-1).payload), {});
});

test('registration wires app bar and mobile fallback to the same RHS and retains site subpath', () => {
    const React = {createElement: (type, props) => ({type, props})};
    const register = load('register-calendar-sidebar.tsx', {react: React, '@fluentui/react-icons': {CalendarLtr24Regular: 'icon'}, './manifest': {id: 'calendar'}, './components/calendar-sidebar': 'Sidebar', './components/utils': () => 'https://example.com/subpath'}).registerCalendarSidebar;
    let component, appBar, fallback; const actions = [];
    const registry = {registerRightHandSidebarComponent: (...args) => {component = args; return {id: 'rhs', toggleRHSPlugin: 'toggle', hideRHSPlugin: 'hide'};}, registerAppBarComponent: (...args) => {appBar = args;}, registerChannelHeaderButtonAction: (...args) => {fallback = args;}};
    register(registry, action => actions.push(action));
    assert.equal(component[1], 'Calendar'); assert.equal(component[2], false);
    assert.equal(appBar[0], 'https://example.com/subpath/plugins/calendar/public/calendar.svg'); assert.equal(appBar[3], null);
    appBar[1](); fallback[1](); component[0]().props.onOpenCalendar();
    assert.deepEqual(actions, ['toggle', 'toggle', 'hide']);
    assert.doesNotThrow(() => register({...registry, registerAppBarComponent: undefined}, () => {}));
});
