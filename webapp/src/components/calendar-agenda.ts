import {GetEventsResponse} from '../client';

export type AgendaItem = {event: GetEventsResponse; time: string; ongoing: boolean};
export type AgendaDay = {date: string; label: string; items: AgendaItem[]};

export function agendaTimeZone(timezone: {[key: string]: string | boolean} = {}): string {
    const automatic = timezone.useAutomaticTimezone === true || timezone.useAutomaticTimezone === 'true';
    const zone = automatic ? timezone.automaticTimezone : timezone.manualTimezone;
    if (typeof zone === 'string' && zone) {
        try {
            new Intl.DateTimeFormat('en', {timeZone: zone}).format();
            return zone;
        } catch (e) {
            // A missing/invalid preference falls back to the browser's timezone.
        }
    }
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function agendaDate(date: Date, timeZone: string): string {
    const parts = new Intl.DateTimeFormat('en', {timeZone, year: 'numeric', month: '2-digit', day: '2-digit'}).formatToParts(date);
    const part = (type: string) => parts.find((value) => value.type === type)!.value;
    return `${part('year')}-${part('month')}-${part('day')}`;
}

export function addAgendaDays(date: string, days: number): string {
    const value = new Date(`${date}T00:00:00Z`);
    value.setUTCDate(value.getUTCDate() + days);
    return value.toISOString().slice(0, 10);
}

export function agendaRange(now: Date, timeZone: string): {start: string; end: string} {
    const today = agendaDate(now, timeZone);
    // The API expects local wall-clock fields without an offset.
    return {start: `${today}T00:00:00`, end: `${addAgendaDays(today, 7)}T00:00:00`};
}

export function agendaDayLabel(date: string, today: string): string {
    if (date === today) {
        return 'Today';
    }
    if (date === addAgendaDays(today, 1)) {
        return 'Tomorrow';
    }
    return new Intl.DateTimeFormat(undefined, {timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short'}).format(new Date(`${date}T00:00:00Z`));
}

export function buildAgenda(events: GetEventsResponse[], now: Date, timeZone: string): AgendaDay[] {
    const today = agendaDate(now, timeZone);
    const lastDay = addAgendaDays(today, 7);
    const days = new Map<string, AgendaItem[]>();
    const timeOptions: Intl.DateTimeFormatOptions & {hourCycle: 'h23'} = {timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23'};
    const timeFormat = new Intl.DateTimeFormat(undefined, timeOptions);
    const endFormat = new Intl.DateTimeFormat(undefined, {...timeOptions, month: 'short', day: 'numeric'});
    events.forEach((event) => {
        const start = new Date(event.start);
        const end = new Date(event.end);
        if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end < start) {
            return;
        }
        const startDay = event.allDay ? event.start.slice(0, 10) : agendaDate(start, timeZone);
        const endDay = event.allDay ? event.end.slice(0, 10) : agendaDate(end, timeZone);
        if (event.allDay ? endDay <= today : end.getTime() <= now.getTime()) {
            return;
        }
        const day = startDay < today ? today : startDay;
        if (day >= lastDay) {
            return;
        }
        let time: string;
        if (event.allDay) {
            time = 'All day';
            if (endDay > addAgendaDays(day, 1)) {
                time += ` · until ${agendaDayLabel(addAgendaDays(endDay, -1), today)}`;
            }
        } else {
            time = `${timeFormat.format(start)} – ${startDay === endDay ? timeFormat.format(end) : endFormat.format(end)}`;
        }
        const item = {event, time, ongoing: !event.allDay && start <= now && now < end};
        days.set(day, [...(days.get(day) || []), item]);
    });
    return Array.from(days.keys()).sort().map((date) => ({
        date,
        label: agendaDayLabel(date, today),
        items: days.get(date)!.sort((a, b) => Number(Boolean(b.event.allDay)) - Number(Boolean(a.event.allDay)) || new Date(a.event.start).getTime() - new Date(b.event.start).getTime()),
    }));
}
