import {SelectedEventTime} from '../types/event';

import {agendaDate} from './calendar-agenda';

// The editor stores wall-clock fields in browser-local Dates; the server reads
// those fields in the user's Mattermost timezone rather than as UTC instants.
export function newEventTime(now: Date, timeZone: string, selectedDate?: string, allDay = false): SelectedEventTime {
    const options: Intl.DateTimeFormatOptions & {hourCycle: 'h23'} = {timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'};
    const parts = new Intl.DateTimeFormat('en', options).formatToParts(now);
    const part = (type: string) => parts.find((value) => value.type === type)!.value;
    const today = agendaDate(now, timeZone);
    const rounded = new Date(`${today}T${part('hour')}:${part('minute')}:${part('second')}.${String(now.getMilliseconds()).padStart(3, '0')}Z`);
    rounded.setUTCMinutes(Math.ceil((rounded.getUTCMinutes() + rounded.getUTCSeconds() / 60 + rounded.getUTCMilliseconds() / 60000) / 30) * 30, 0, 0);
    const day = selectedDate || (allDay ? today : rounded.toISOString().slice(0, 10));
    const start = new Date(`${day}T${rounded.toISOString().slice(11)}`);
    const end = new Date(start.getTime() + 30 * 60000);
    const editorDate = (value: Date) => new Date(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate(), value.getUTCHours(), value.getUTCMinutes());
    return {
        start: editorDate(start),
        end: allDay ? editorDate(start) : editorDate(end),
        startTime: start.toISOString().slice(11, 16),
        endTime: end.toISOString().slice(11, 16),
    };
}
