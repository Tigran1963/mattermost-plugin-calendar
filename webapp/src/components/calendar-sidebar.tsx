import React, {useEffect, useRef, useState} from 'react';
import {useDispatch, useSelector} from 'react-redux';
import {useHistory, useLocation} from 'react-router-dom';
import {getCurrentUser} from 'mattermost-redux/selectors/entities/users';
import {Button, FluentProvider, webLightTheme} from '@fluentui/react-components';
import {ArrowClockwise16Regular, ArrowUpRight16Regular, CalendarEmpty16Filled, CalendarLtr24Regular, ChevronRight16Regular} from '@fluentui/react-icons';

import {ApiClient, GetEventsResponse} from '../client';
import {closeEventModal, eventSelected, openEventModal} from '../actions';
import {getCalendarSettings, selectIsOpenEventModal} from '../selectors';

import EventModalComponent from './event';
import {agendaRange, agendaTimeZone, buildAgenda} from './calendar-agenda';
import './calendar-sidebar.css';

interface CalendarSidebarProps {
    onOpenCalendar: () => void;
}

const CalendarSidebar = ({onOpenCalendar}: CalendarSidebarProps) => {
    const dispatch = useDispatch();
    const history = useHistory();
    const location = useLocation();
    const user = useSelector(getCurrentUser);
    const settings = useSelector(getCalendarSettings);
    const modalOpen = useSelector(selectIsOpenEventModal);
    const timeZone = agendaTimeZone(user?.timezone);
    const [events, setEvents] = useState<GetEventsResponse[]>([]);
    const [now, setNow] = useState(new Date());
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);
    const [refresh, setRefresh] = useState(0);
    const ownsModal = useRef(false);
    const onCalendarPage = location.pathname === '/calendar' || location.pathname.startsWith('/calendar/');

    useEffect(() => {
        if (!modalOpen) {
            ownsModal.current = false;
        }
    }, [modalOpen]);

    useEffect(() => () => {
        if (ownsModal.current) {
            dispatch(closeEventModal());
            dispatch(eventSelected({}));
        }
    }, [dispatch]);

    useEffect(() => {
        if (!user?.id || modalOpen) {
            return;
        }
        let controller: AbortController | undefined;
        const load = async () => {
            controller?.abort();
            const request = new AbortController();
            controller = request;
            const current = new Date();
            const range = agendaRange(current, timeZone);
            setNow(current);
            setLoading(true);
            try {
                const response = await ApiClient.getEvents(range.start, range.end, request.signal);
                if (!request.signal.aborted) {
                    setEvents(response.data);
                    setError(false);
                }
            } catch (e) {
                if (!request.signal.aborted) {
                    setError(true);
                }
            } finally {
                if (!request.signal.aborted) {
                    setLoading(false);
                }
            }
        };
        load();
        const timer = window.setInterval(load, 60000);
        window.addEventListener('focus', load);
        return () => {
            controller?.abort();
            window.clearInterval(timer);
            window.removeEventListener('focus', load);
        };
    }, [user?.id, timeZone, modalOpen, refresh]);

    const createEvent = () => {
        dispatch(eventSelected({}));
        dispatch(openEventModal());
        ownsModal.current = !onCalendarPage;
    };

    const days = buildAgenda(events, now, timeZone);

    return (
        <FluentProvider theme={webLightTheme} className='calendar-sidebar'>
            <div className='calendar-sidebar-toolbar'>
                <div className='calendar-sidebar-heading'>
                    <div>
                        <h2>Upcoming</h2>
                        <p>Next 7 days <span title={timeZone}>· {timeZone.replace(/_/g, ' ')}</span></p>
                    </div>
                    <Button
                        type='button'
                        appearance='subtle'
                        size='medium'
                        icon={<ArrowClockwise16Regular/>}
                        className='calendar-sidebar-icon-button'
                        aria-label='Refresh calendar'
                        title='Refresh calendar'
                        disabled={loading}
                        onClick={() => setRefresh((value) => value + 1)}
                    />
                </div>
                <Button type='button' appearance='primary' size='medium' icon={<CalendarEmpty16Filled/>} className='calendar-sidebar-create' onClick={createEvent}>
                    {'Create'}
                </Button>
            </div>
            <div className='calendar-sidebar-agenda' aria-label='Upcoming events' aria-busy={loading}>
                {error && (
                    <div className='calendar-sidebar-error' role='alert'>
                        <p>Could not load events.</p>
                        <Button type='button' appearance='subtle' onClick={() => setRefresh((value) => value + 1)}>Try again</Button>
                    </div>
                )}
                {loading && events.length === 0 ? <p className='calendar-sidebar-message' role='status'>Loading events…</p> : (
                    days.length === 0 && !error ? (
                        <div className='calendar-sidebar-empty'>
                            <CalendarLtr24Regular aria-hidden='true'/>
                            <strong>No upcoming events</strong>
                            <p>Nothing scheduled for the next 7 days.</p>
                        </div>
                    ) : days.map((day) => (
                        <section key={day.date} className='calendar-sidebar-day' aria-label={day.label}>
                            <h3>{day.label}</h3>
                            {day.items.map(({event, time, ongoing}) => (
                                <button
                                    key={`${event.id}-${event.start}`}
                                    type='button'
                                    className='calendar-sidebar-event'
                                    onClick={() => {
                                        dispatch(eventSelected({event: {id: event.id}}));
                                        dispatch(openEventModal());
                                        ownsModal.current = !onCalendarPage;
                                    }}
                                >
                                    <span className='calendar-sidebar-dot' style={{backgroundColor: event.type === 'event' ? settings.eventColor : settings.callColor}} aria-hidden='true'/>
                                    <span className='calendar-sidebar-event-content'>
                                        <span className='calendar-sidebar-event-time'>{time}{ongoing && <span className='calendar-sidebar-now'>Now</span>}</span>
                                        <strong>{event.title}</strong>
                                        <span className='calendar-sidebar-event-type'>{event.type === 'event' ? 'Event' : 'Call'}</span>
                                    </span>
                                    <ChevronRight16Regular aria-hidden='true'/>
                                </button>
                            ))}
                        </section>
                    ))
                )}
            </div>
            <div className='calendar-sidebar-footer'>
                <Button type='button' appearance='subtle' icon={<ArrowUpRight16Regular/>} iconPosition='after' onClick={() => {onOpenCalendar(); history.push('/calendar');}}>
                    {'Open calendar'}
                </Button>
            </div>
            {/* The product page already owns its modal; the channels view needs its own host. */}
            {modalOpen && !onCalendarPage && <EventModalComponent/>}
        </FluentProvider>
    );
};

export default CalendarSidebar;
