import React, { useEffect, useRef, useState } from 'react';
import { Client4 } from 'mattermost-redux/client';
import { UserProfile } from 'mattermost-redux/types/users';
import { Channel } from 'mattermost-redux/types/channels';
import { Team } from 'mattermost-redux/types/teams';

import { useDispatch, useSelector } from 'react-redux';

import { getCurrentTeamId, getCurrentTeam, getMyTeams } from 'mattermost-redux/selectors/entities/teams';
import { getMyTeams as fetchMyTeams } from 'mattermost-redux/actions/teams';
import { getCurrentUser, getCurrentUserId, getUser, getUserStatuses } from 'mattermost-redux/selectors/entities/users';
import { getTeammateNameDisplaySetting } from 'mattermost-redux/selectors/entities/preferences';
import { getMissingProfilesByIds } from 'mattermost-redux/actions/users';

// importing the editor and the plugin from their full paths
import {
    Eye24Regular,
    ChatMultiple24Regular,
    Clock24Regular,
    Delete16Regular,
    Dismiss12Regular,
    Pen24Regular,
    PersonAdd24Regular,
    Save16Regular,
    TextDescription24Regular,
    Video24Regular
} from '@fluentui/react-icons';
import {
    Button,
    Combobox,
    Dialog,
    DialogActions,
    DialogBody,
    DialogContent,
    DialogSurface,
    DialogTitle,
    DialogTrigger,
    Input,
    Option,
    OptionGroup,
    Persona,
    Skeleton,
    SkeletonItem,
    Spinner,
    Textarea,
    useId,
    Toast,
    ToastIntent,
    ToastTitle,
    useToastController,
    Toaster
} from '@fluentui/react-components';
import { format, parse, set, startOfDay, addDays, subDays } from 'date-fns';
import { InputOnChangeData } from '@fluentui/react-input';
import { Toggle } from '@fluentui/react/lib/Toggle';

import { GlobalState } from 'mattermost-redux/types/store';

import { closeEventModal, eventSelected, updateMembersAddedInEvent, updateSelectedEventTime } from 'actions';
import { getCalendarSettings, getMembersAddedInEvent, getSelectedCalendarType, getSelectedEventTime, selectIsOpenEventModal, selectSelectedEvent } from 'selectors';
import { ApiClient } from 'client';

import RepeatEventCustom from './repeat-event';

import { refetchCalendarEvents } from './calendar';
import TimeSelector from './time-selector';
import PlanningAssistant from './planning-assistant';
import EventAlertSelect from "./alert-input";

// visibility is pinned to "team" for now (see DEFAULT_VISIBILITY below); the
// picker is kept around, just not wired into the form, for whenever it's
// needed again
// import VisibilitySelect from './visibility-input';
import EventTypeSelect from './event-type-input';
import MentionSelect from './mention-input';
import {agendaTimeZone} from './calendar-agenda';
import {newEventTime} from './new-event-time';

interface AddedUserComponentProps {
    user: UserProfile
}

interface TimeSelectItemsProps {
    start?: string;
    end?: string;
}

type SelectionEvents =
    React.ChangeEvent<HTMLElement>
    | React.KeyboardEvent<HTMLElement>
    | React.MouseEvent<HTMLElement, MouseEvent>
declare type OptionOnSelectData = {
    optionValue: string | undefined;
    optionText: string | undefined;
    selectedOptions: string[];
};

// new events are visible to the whole team unless the user narrows it down
const DEFAULT_VISIBILITY = 'team';

// the "call" calendar is the one that gets a video meeting link; an event is a
// plain calendar entry
const EVENT_TYPE_CALL = 'call';
const EVENT_TYPE_EVENT = 'event';

// Nobody gets pinged unless the user asks for it.
const DEFAULT_MENTION = '';

// default alert for a new call: ping right when it starts. Events and all-day
// events default to no alert at all.
const EVENT_ALERT_AT_START_TIME = 'at_start_time';

// "all" is a combined view rather than a real calendar, so there is no calendar
// to inherit from — a new entry made from it starts out as a call.
const defaultTypeForCalendar = (calendarType: string): string => {
    return calendarType === EVENT_TYPE_EVENT ? EVENT_TYPE_EVENT : EVENT_TYPE_CALL;
};

// an event spans whole days by default and stays silent; a call is a timed slot
// that pings when it starts
const isCallType = (type: string): boolean => type === EVENT_TYPE_CALL;

const parseEventDate = (value: string, allDay: boolean): Date => {
    return parse(value, allDay ? 'yyyy-MM-dd' : "yyyy-MM-dd'T'HH:mm:ssxxx", new Date());
};

const EventModalComponent = () => {
    const selectedEvent = useSelector(selectSelectedEvent);
    const isEditingEvent = selectedEvent?.event?.id != null;
    const isOpenEventModal = useSelector(selectIsOpenEventModal);

    const displayNameSettings = useSelector(getTeammateNameDisplaySetting);

    const currentTeamId = useSelector(getCurrentTeamId);
    const currentTeam = useSelector(getCurrentTeam);
    const myTeams: Team[] = useSelector(getMyTeams);

    const UserStatusSelector = useSelector(getUserStatuses);
    const currentUserId = useSelector(getCurrentUserId);
    const currentUser = useSelector(getCurrentUser);
    const selectedEventTime = useSelector(getSelectedEventTime);
    const settings = useSelector(getCalendarSettings);
    const selectedCalendarType = useSelector(getSelectedCalendarType);

    const dispatch = useDispatch();

    // The calendar is registered as a product and lives on its own route, so
    // Mattermost's "current team" is empty until the user has opened a team at
    // least once in this session. With an empty team id channel autocomplete
    // hits /api/v4/teams//channels/autocomplete and 404s, and saved events end
    // up with no team, which hides every team-visible event afterwards. Falling
    // back to a team the user actually belongs to keeps both working.
    const teamsRequested = useRef(false);

    useEffect(() => {
        if (!currentTeamId && myTeams.length === 0 && !teamsRequested.current) {
            teamsRequested.current = true;
            dispatch(fetchMyTeams());
        }
    }, [currentTeamId, myTeams.length]);

    const resolvedTeam: Team | undefined = currentTeam || myTeams[0];
    const teamId: string = currentTeamId || resolvedTeam?.id || '';

    const [isLoading, setIsLoading] = useState(false);
    const [isSaving, setIsSaving] = useState(false);

    const usersMentionTags: {
        [name: string]: string
    } = {
        '@channel': 'Choose all users from channel',
    };
    const [usersAutocomplete, setUsersAutocomplete] = useState<UserProfile[]>([]);
    const userSearchRequest = useRef(0);

    const [searchUsersInput, setSearchUsersInput] = useState('');

    const [selectedAlert, setSelectedAlert] = useState('');
    const [selectedType, setSelectedType] = useState(EVENT_TYPE_CALL);
    const [selectedAllDay, setSelectedAllDay] = useState(false);
    const [selectedMention, setSelectedMention] = useState(DEFAULT_MENTION);
    const [meetingLink, setMeetingLink] = useState('');
    const [eventOwner, setEventOwner] = useState('');

    // The event only carries the owner's id, so the profile comes from the
    // store. getMissingProfilesByIds skips anyone already loaded, so opening
    // events by the same person doesn't refetch them.
    const eventOwnerProfile: UserProfile | undefined = useSelector(
        (state: GlobalState) => (eventOwner ? getUser(state, eventOwner) : undefined),
    );

    useEffect(() => {
        if (eventOwner && !eventOwnerProfile) {
            dispatch(getMissingProfilesByIds([eventOwner]));
        }
    }, [eventOwner, eventOwnerProfile]);

    // once the user has explicitly picked an alert or flipped the all-day
    // toggle, the smart type defaults below stop overwriting their choice
    const alertTouchedRef = useRef(false);
    const allDayTouchedRef = useRef(false);

    // all-day and alert follow the event type until the user overrides either
    // of them by hand
    const applyTypeDefaults = (type: string) => {
        const isCall = isCallType(type);
        const allDay = allDayTouchedRef.current ? selectedAllDay : !isCall;
        if (!allDayTouchedRef.current) {
            setSelectedAllDay(allDay);
        }
        if (!alertTouchedRef.current) {
            setSelectedAlert(isCall && !allDay ? EVENT_ALERT_AT_START_TIME : '');
        }
    };

    const [channelsAutocomplete, setChannelsAutocomplete] = useState<Channel[]>([]);
    const [selectedChannel, setSelectedChannel] = useState<Partial<Channel>>({});
    const [selectedChannelText, setSelectedChannelText] = useState('');
    const channelSearchRequest = useRef(0);
    const channelMembersRequest = useRef(0);
    const channelMembersLoading = useRef(false);
    const [isLoadingChannelMembers, setIsLoadingChannelMembers] = useState(false);

    useEffect(() => {
        channelSearchRequest.current += 1;
        channelMembersRequest.current += 1;
        channelMembersLoading.current = false;
        setIsLoadingChannelMembers(false);
        setChannelsAutocomplete([]);
        // A late team fallback must not erase the channel loaded with an existing event.
        if (!isEditingEvent) {
            setSelectedChannel({});
            setSelectedChannelText('');
        }
        return () => {
            channelSearchRequest.current += 1;
            channelMembersRequest.current += 1;
        };
    }, [teamId, isEditingEvent]);

    const [selectedVisibility, setSelectedVisibility] = useState(DEFAULT_VISIBILITY)

    const [isPlanningAssistantOpen, setIsPlanningAssistantOpen] = useState(false);
    const inputEventTitleRef = React.useRef<HTMLInputElement>(null);

    const usersAddedInEvent: UserProfile[] = useSelector(getMembersAddedInEvent);
    const usersAddedInEventRef = useRef(usersAddedInEvent);
    usersAddedInEventRef.current = usersAddedInEvent;

    const [titleEvent, setTitleEvent] = useState('');
    const [descriptionEvent, setDescriptionEvent] = useState('');

    // whitespace-only is not a title
    const hasTitle = titleEvent.trim() !== '';

    const [repeatRule, setRepeatRule] = useState<string>('');
    const [showCustomRepeat, setShowCustomRepeat] = useState(false);
    const [repeatOption, setRepeatOption] = useState("Don't repeat");
    const [repeatOptionsSelected, setRepeatOptionsSelected] = useState(['empty']);

    const toasterId = useId("toasterEventForm");
    const { dispatchToast } = useToastController(toasterId);

    // methods
    const viewEventModalHandleClose = () => {
        cleanState();
        dispatch(closeEventModal());
        dispatch(eventSelected({}));
    };

    const cleanState = (selectedDate?: string) => {
        setTitleEvent('');
        setDescriptionEvent('');

        setIsSaving(false);
        setIsLoading(false);

        const defaultType = defaultTypeForCalendar(selectedCalendarType);
        dispatch(updateSelectedEventTime(newEventTime(new Date(), agendaTimeZone(currentUser?.timezone), selectedDate, !isCallType(defaultType))));

        userSearchRequest.current += 1;
        channelSearchRequest.current += 1;
        channelMembersRequest.current += 1;
        channelMembersLoading.current = false;
        setIsLoadingChannelMembers(false);
        setUsersAutocomplete([]);
        setChannelsAutocomplete([]);
        setSelectedChannelText('');
        setSelectedChannel({});
        setSearchUsersInput('');

        // repeat state
        setShowCustomRepeat(false);
        setRepeatOptionsSelected(['empty']);
        setRepeatOption('Don\'t repeat');
        setRepeatRule('');

        setSelectedChannel({});
        dispatch(updateMembersAddedInEvent([]));

        setMeetingLink('');
        setEventOwner('');
        setSelectedMention(DEFAULT_MENTION);

        setSelectedVisibility(DEFAULT_VISIBILITY);
        alertTouchedRef.current = false;
        allDayTouchedRef.current = false;

        // a new event belongs to the calendar the user is currently looking at,
        // otherwise it would be saved out of view
        setSelectedType(defaultType);
        applyTypeDefaults(defaultType);
    };

    const onTitleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        setTitleEvent(event.target.value);
    };

    const onStartDateChange = (event: React.ChangeEvent<HTMLInputElement>, data: InputOnChangeData) => {
        dispatch(updateSelectedEventTime({ start: parse(data.value, 'yyyy-MM-dd', new Date()) }));
    };

    const onEndDateChange = (event: React.ChangeEvent<HTMLInputElement>, data: InputOnChangeData) => {
        dispatch(updateSelectedEventTime({ end: parse(data.value, 'yyyy-MM-dd', new Date()) }));
    };

    const loadUserOptions = async (search: string = '') => {
        const request = ++userSearchRequest.current;
        try {
            const users = search === '' ?
                await Client4.getProfiles(0, 100, {active: true}) :
                await Client4.searchUsers(search, {allow_inactive: false});
            // Opening the picker and typing can overlap; only show the latest result.
            if (request === userSearchRequest.current) {
                setUsersAutocomplete(users.filter((user) => !user.delete_at));
            }
        } catch (e) {
            if (request === userSearchRequest.current) {
                setUsersAutocomplete([]);
            }
        }
    };

    const onInputUserAction = async (event: React.ChangeEvent<HTMLInputElement>) => {
        setSearchUsersInput(event.target.value);
        await loadUserOptions(event.target.value);
    };

    const onSelectChannelOption = (event: SelectionEvents, data: OptionOnSelectData) => {
        channelSearchRequest.current += 1;
        channelMembersRequest.current += 1;
        channelMembersLoading.current = false;
        setIsLoadingChannelMembers(false);
        channelsAutocomplete.map((option) => {
            if (option.id === data.optionValue) {
                setSelectedChannel(option);
                setSelectedChannelText(option.display_name);
            }
        });
    };

    const notArchived = (channels: Channel[]): Channel[] => {
        return (channels || []).filter((channel) => !channel.delete_at);
    };

    const loadMyChannels = async () => {
        const request = ++channelSearchRequest.current;
        if (!teamId) {
            setChannelsAutocomplete([]);
            return;
        }
        try {
            const channels = await Client4.getMyChannels(teamId);
            if (request === channelSearchRequest.current) {
                setChannelsAutocomplete(notArchived(channels).filter((channel) => channel.type === 'O' || channel.type === 'P'));
            }
        } catch (e) {
            // Keep the current list; searching is still available if loading fails.
        }
    };

    const onInputChannelAction = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const request = ++channelSearchRequest.current;
        channelMembersRequest.current += 1;
        channelMembersLoading.current = false;
        setIsLoadingChannelMembers(false);
        setSelectedChannel({});
        setSelectedChannelText(event.target.value);
        if (event.target.value === '') {
            // Restore the user's channels after clearing the input.
            await loadMyChannels();
            return;
        }
        if (!teamId) {
            // without a team the autocomplete endpoint 404s, and the rejected
            // promise used to surface as an uncaught error in the console
            setChannelsAutocomplete([]);
            return;
        }
        try {
            const resp = await Client4.autocompleteChannels(teamId, event.target.value);
            if (request === channelSearchRequest.current) {
                setChannelsAutocomplete(notArchived(resp));
            }
        } catch (e) {
            if (request === channelSearchRequest.current) {
                setChannelsAutocomplete([]);
            }
        }
    };

    const showErrorToast = (message: string) => {
        dispatchToast(
            <Toast>
                <ToastTitle></ToastTitle>
                {message}
            </Toast>,
            { intent: 'error' }
        );
    };

    const chooseAllUsersFromChannel = async () => {
        if (!selectedChannel.id || channelMembersLoading.current) {
            return;
        }
        const request = ++channelMembersRequest.current;
        channelMembersLoading.current = true;
        setIsLoadingChannelMembers(true);
        try {
            // Fetch on demand instead of trusting a possibly empty or partial store cache.
            const profiles = await Client4.getProfilesInChannel(selectedChannel.id, 0, 1000, '', {active: true});
            if (request !== channelMembersRequest.current) {
                return;
            }
            const members = new Map<string, UserProfile>();
            [...usersAddedInEventRef.current, ...profiles].forEach((user) => {
                if (!user.delete_at) {
                    members.set(user.id, user);
                }
            });
            dispatch(updateMembersAddedInEvent(Array.from(members.values())));
        } catch (e) {
            if (request === channelMembersRequest.current) {
                showErrorToast('Failed to load channel members, please try again');
            }
        } finally {
            if (request === channelMembersRequest.current) {
                channelMembersLoading.current = false;
                setIsLoadingChannelMembers(false);
            }
        }
    };

    // combines a date with an "HH:mm" time string into a real Date, used only to
    // compare start against end locally.
    const buildDateTime = (date: Date, time: string): Date => {
        const [hours, minutes] = time.split(':').map(Number);
        return set(date, { hours, minutes: minutes || 0, seconds: 0, milliseconds: 0 });
    };

    // The server re-reads the wall-clock fields of whatever timestamp it receives
    // and interprets them in the user's Mattermost timezone, so the picked wall
    // clock has to be sent as-is. Converting to a real UTC instant here would make
    // the server apply the offset a second time.
    const toServerDateTime = (date: Date): string => {
        return format(date, 'yyyy-MM-dd') + 'T' + format(date, 'HH:mm') + ':00Z';
    };

    // All-day events are stored as an exclusive day range (end is midnight of
    // the day *after* the last day), as FullCalendar and iCal expect. The server
    // converts these local midnights to UTC when saving.
    const buildEventRange = (): { start: Date; end: Date } => {
        if (selectedAllDay) {
            return {
                start: startOfDay(selectedEventTime.start),
                end: addDays(startOfDay(selectedEventTime.end), 1),
            };
        }
        return {
            start: buildDateTime(selectedEventTime.start, selectedEventTime.startTime),
            end: buildDateTime(selectedEventTime.end, selectedEventTime.endTime),
        };
    };

    const onSaveEvent = async () => {

        // the Save button is disabled without a title, this is just a guard
        if (!hasTitle) {
            showErrorToast('Add a title first');
            return;
        }

        if (selectedVisibility === "channel" && Object.keys(selectedChannel).length === 0) {
            showErrorToast('You selected channel visibility but you didn\'t select a channel');
            return;
        }

        const { start, end } = buildEventRange();

        if (end.getTime() <= start.getTime()) {
            showErrorToast(selectedAllDay ? 'End date must not be before start date' : 'End time must be after start time');
            return;
        }

        if (selectedVisibility === 'team' && !teamId) {
            showErrorToast('You are not a member of any team, pick another visibility');
            return;
        }

        const members: string[] = usersAddedInEvent.map((user: UserProfile) => user.id);
        // a meeting event isn't a call, so it never carries a video link
        const linkToSave = selectedType === EVENT_TYPE_CALL ? meetingLink : '';
        // the mention only ever lands in a channel post, so an event that
        // doesn't produce one (no channel, or all-day) must not keep a stale
        // mention around
        const postsToChannel = !selectedAllDay && Object.keys(selectedChannel).length !== 0;
        const mentionToSave = postsToChannel ? selectedMention : '';
        let repeat = '';
        if (repeatOption === 'Custom') {
            repeat = repeatRule;
        }
        setIsSaving(true);
        try {
            if (selectedEvent?.event?.id == null) {
                await ApiClient.createEvent(
                    titleEvent,
                    toServerDateTime(start),
                    toServerDateTime(end),
                    members,
                    descriptionEvent,
                    teamId,
                    selectedVisibility,
                    Object.keys(selectedChannel).length !== 0 ? selectedChannel.id : null,
                    repeat,

                    // the color comes from the calendar the event belongs to and is
                    // resolved server-side on read, so nothing is stored per event
                    undefined,
                    selectedAlert,
                    selectedType,
                    linkToSave,
                    selectedAllDay,
                    mentionToSave,
                );
            } else {
                await ApiClient.updateEvent(
                    selectedEvent.event.id,
                    titleEvent,
                    toServerDateTime(start),
                    toServerDateTime(end),
                    members,
                    descriptionEvent,
                    teamId,
                    selectedVisibility,
                    Object.keys(selectedChannel).length !== 0 ? selectedChannel.id : null,
                    repeat,

                    // the color comes from the calendar the event belongs to and is
                    // resolved server-side on read, so nothing is stored per event
                    undefined,
                    selectedAlert,
                    selectedType,
                    linkToSave,
                    selectedAllDay,
                    mentionToSave,
                );
            }
            refetchCalendarEvents();
            cleanState();
            viewEventModalHandleClose();
        } catch (e) {
            showErrorToast('Failed to save event, please try again');
        } finally {
            setIsSaving(false);
        }
    };

    const onRemoveEvent = async () => {
        if (repeatRule !== '' && !window.confirm('This is a recurring event. Removing it will remove the entire series. Continue?')) {
            return;
        }
        try {
            await ApiClient.removeEvent(selectedEvent.event.id);
            refetchCalendarEvents();
            cleanState();
            viewEventModalHandleClose();
        } catch (e) {
            showErrorToast('Failed to remove event, please try again');
        }
    };

    const onGenerateMeetingLink = () => {
        const roomSlug = `mm-calendar-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
        setMeetingLink(`${settings.jitsiBaseUrl}/${roomSlug}`);
    };

    // all-day events have no meaningful "moment" to alert at, so switching it
    // on clears whatever alert was picked; switching back off restores the
    // type's smart default as long as the user hasn't picked one themselves
    const onAllDayToggle = (checked: boolean) => {
        allDayTouchedRef.current = true;
        setSelectedAllDay(checked);
        if (checked) {
            setSelectedAlert('');
        } else if (!alertTouchedRef.current) {
            setSelectedAlert(isCallType(selectedType) ? EVENT_ALERT_AT_START_TIME : '');
        }
        if (!checked && buildDateTime(selectedEventTime.end, selectedEventTime.endTime) <= buildDateTime(selectedEventTime.start, selectedEventTime.startTime)) {
            dispatch(updateSelectedEventTime({end: addDays(startOfDay(selectedEventTime.start), 1)}));
        }
    };

    // Fluent's dialog only locks scrolling when the body itself is the
    // scrolling element, which it isn't inside a Mattermost product route, so
    // the page behind the form kept scrolling. The class is cleaned up on
    // unmount too, otherwise a modal open during a route change would leave the
    // whole page frozen.
    useEffect(() => {
        const className = 'calendar-event-modal-open';
        document.body.classList.toggle(className, Boolean(isOpenEventModal));
        return () => document.body.classList.remove(className);
    }, [isOpenEventModal]);

    useEffect(() => {
        if (isOpenEventModal && selectedEvent?.event?.id == null) {
            cleanState(selectedEvent?.newEventDate);
        }
    }, [isOpenEventModal]);

    useEffect(() => {
        let cancelled = false;

        if (selectedEvent?.event?.id != null) {
            setIsLoading(true);
            ApiClient.getEventById(selectedEvent.event.id).then((data) => {
                if (cancelled) {
                    return;
                }
                setTitleEvent(data.data.title);
                setDescriptionEvent(data.data.description);

                const isAllDay = Boolean(data.data.allDay);
                const startEventResp: Date = parseEventDate(data.data.start, isAllDay);
                const endEventResp: Date = parseEventDate(data.data.end, isAllDay);

                // the server stores an exclusive end (midnight of the day
                // after the last day); the End field shows the last actual day
                const displayEnd = isAllDay ? subDays(endEventResp, 1) : endEventResp;

                setSelectedAllDay(isAllDay);
                dispatch(updateSelectedEventTime({
                    start: startEventResp,
                    end: displayEnd,
                    startTime: format(startEventResp, 'HH:mm'),
                    endTime: format(displayEnd, 'HH:mm'),
                }));
                dispatch(updateMembersAddedInEvent(data.data.attendees));

                setSelectedType(data.data.type || EVENT_TYPE_CALL);
                setMeetingLink(data.data.meetingLink || '');
                setEventOwner(data.data.owner);
                setSelectedVisibility(data.data.visibility || DEFAULT_VISIBILITY);
                // an existing event's alert and all-day flag were already an
                // intentional choice, not the smart default — don't let a later
                // type change stomp them
                alertTouchedRef.current = true;
                allDayTouchedRef.current = true;
                setSelectedAlert(data.data.alert);
                setSelectedMention(data.data.mention ?? '');

                if (data.data.recurrence.length !== 0) {
                    setRepeatRule(data.data.recurrence);
                    setRepeatOption('Custom');
                    setShowCustomRepeat(true);
                }

                if (data.data.channel != null) {
                    Client4.getChannel(data.data.channel).then((channel: Channel) => {
                        if (!cancelled) {
                            setSelectedChannel(channel);
                            setSelectedChannelText(channel.display_name);
                        }
                    });
                }
                setIsLoading(false);
            }).catch(() => {
                if (!cancelled) {
                    setIsLoading(false);
                    showErrorToast('Failed to load event, please try again');
                }
            });
        }

        return () => {
            cancelled = true;
        };
    }, [selectedEvent]);

    const getDisplayUserName = (user: UserProfile) => {
        const fullName = `${user.first_name} ${user.last_name}`.trim();

        if (displayNameSettings === 'full_name') {
            return fullName || user.username;
        }
        if (displayNameSettings === 'username') {
            return user.username;
        }

        if (displayNameSettings === 'nickname_full_name') {
            if (user.nickname !== '') {
                return user.nickname;
            }
            return fullName || user.username;
        }

        // any other display setting (or none at all) used to fall through and
        // return undefined, rendering blank names
        return user.username;
    };

    const repeatOnSelect = (event: SelectionEvents, data: OptionOnSelectData) => {
        if (data.optionValue === 'custom') {
            setRepeatOption('Custom');
            setShowCustomRepeat(true);
            setRepeatOptionsSelected(['custom']);
        } else {
            setRepeatOption("Don't repeat");
            setShowCustomRepeat(false);
            setRepeatOptionsSelected(['empty']);
        }
    };

    const AddedUserComponent = (props: AddedUserComponentProps) => {
        let stat = 'unknown';
        if (UserStatusSelector[props.user.id] === 'online') {
            stat = 'available';
        }

        return (<span className='added-user-badge-container'>
            <Persona
                name={getDisplayUserName(props.user)}
                avatar={{ color: 'colorful' }}
                presence={{ status: stat }}
            />
            <Dismiss12Regular
                className='added-user-badge-icon-container'
                onClick={() => {
                    dispatch(updateMembersAddedInEvent(usersAddedInEvent.filter((item: UserProfile) => item.id !== props.user.id)));
                }}
            />

        </span>);
    };

    const UsersAddedComponent = () => {
        if (usersAddedInEvent.length > 0) {
            return (<div className='added-users-list'>
                {
                    usersAddedInEvent.map((user: UserProfile) => {
                        return <AddedUserComponent user={user} />;
                    })
                }
            </div>);
        }
        return <></>;
    };

    const RemoveEventButton = () => {
        // removing drops the event for every attendee, so the server only lets
        // the owner do it — don't offer the button to anyone else
        if (selectedEvent?.event?.id != null && eventOwner === currentUserId) {
            // 'star' was a typo: DialogActions only knows 'start' and 'end',
            // and anything else leaves the group without grid placement
            return (<DialogActions
                position='start'
                className='event-modal-actions event-modal-actions-start'
            >
                <Button
                    appearance='outline'
                    icon={<Delete16Regular />}
                    onClick={onRemoveEvent}
                >
                    {'Remove'}
                </Button>
            </DialogActions>);
        }
        return <></>;
    };

    const RepeatComponent = () => {
        if (showCustomRepeat) {
            return (
                <RepeatEventCustom
                    selected={repeatRule}
                    onSelect={setRepeatRule}
                />
            );
        }
        return <></>;
    };

    return (
        <div>
            {/* nothing opens this any more — the toolbar button that used to sit
                at the top of the form was removed. Kept mounted because its own
                effect no-ops while closed, so restoring the feature is a matter
                of adding a trigger back. */}
            {
                usersAddedInEvent.length > 0 ? <PlanningAssistant
                    open={isPlanningAssistantOpen}
                    onOpenChange={(ev, data) => {
                        setIsPlanningAssistantOpen(data.open);
                        inputEventTitleRef.current?.focus();
                    }}
                /> : null
            }
            <Dialog open={isOpenEventModal}>
                <DialogSurface>
                    <DialogBody className='event-modal'>
                        <DialogTitle className='event-modal-title' />
                        <DialogContent className='modal-container'>
                            <div className='event-title-container'>
                                <Pen24Regular />
                                <div className='event-input-container'>
                                    {isLoading ? (<Skeleton className='event-input-title'>
                                        <SkeletonItem />
                                    </Skeleton>) : (<>
                                        <Input
                                            ref={inputEventTitleRef}
                                            type='text'
                                            className='event-input-title'
                                            size='large'
                                            appearance='underline'
                                            placeholder='Add a title'
                                            value={titleEvent}
                                            onChange={onTitleChange}
                                            required={true}
                                            aria-required={true}
                                        />
                                        {/* the title has no label of its own to
                                            hang the required marker off */}
                                        <span
                                            className='event-required-mark'
                                            aria-hidden='true'
                                            title='Required'
                                        >{'*'}</span>
                                    </>)}

                                </div>
                            </div>

                            {/* only an existing event has an author worth
                                showing; a new one is always yours */}
                            {!isLoading && selectedEvent?.event?.id != null && eventOwner ? (
                                <div className='event-owner-caption'>
                                    {eventOwner === currentUserId ?
                                        'Created by you' :
                                        `Created by ${eventOwnerProfile ? getDisplayUserName(eventOwnerProfile) : '…'}`}
                                </div>
                            ) : null}

                            <div className='datetime-container'>
                                <Clock24Regular />
                                <div className='event-input-container-datetime event-input-container'>
                                    <div className='datetime-group'>
                                        {isLoading ? (<Skeleton className='start-date-input'>
                                            <SkeletonItem />
                                        </Skeleton>) : (<Input
                                            type='date'
                                            className='start-date-input'
                                            value={format(selectedEventTime?.start, 'yyyy-MM-dd')}
                                            onChange={onStartDateChange}
                                        />)}

                                        {!isLoading && !selectedAllDay && (<TimeSelector
                                            selected={selectedEventTime.startTime}
                                            onSelect={(value) => dispatch(updateSelectedEventTime({ startTime: value }))}
                                        />)}

                                    </div>
                                    <div className='datetime-group datetime-group-end'>
                                        {isLoading ? (
                                            <Skeleton className='end-date-input'>
                                                <SkeletonItem />
                                            </Skeleton>
                                        ) :
                                            (<Input
                                                type='date'
                                                className='end-date-input'
                                                value={format(selectedEventTime?.end, 'yyyy-MM-dd')}
                                                onChange={onEndDateChange}
                                            />)}
                                        {!isLoading && !selectedAllDay && (<TimeSelector
                                            selected={selectedEventTime.endTime}
                                            onSelect={(value) => dispatch(updateSelectedEventTime({ endTime: value }))}
                                        />)}

                                    </div>

                                    {isLoading ? null : (
                                        <Toggle
                                            className='event-all-day-toggle'
                                            label='All day'
                                            inlineLabel={true}
                                            checked={selectedAllDay}
                                            onChange={(ev, checked) => onAllDayToggle(Boolean(checked))}
                                        />
                                    )}
                                </div>
                            </div>
                            <div className='repeat-container'>
                                {isLoading ? (<Skeleton className='skeleton-dropdown'>
                                    <SkeletonItem />
                                </Skeleton>) :
                                    (
                                        <Combobox
                                            onOptionSelect={repeatOnSelect}
                                            selectedOptions={repeatOptionsSelected}
                                            value={repeatOption}
                                        >
                                            <Option
                                                key='empty'
                                                text='empty'
                                            >
                                                Don't repeat
                                            </Option>
                                            <Option
                                                key='custom'
                                                text='custom'
                                            >
                                                Custom
                                            </Option>
                                        </Combobox>
                                    )}
                                <RepeatComponent />
                            </div>

                            <div className='event-channel-container'>
                                <ChatMultiple24Regular />
                                <div className='event-channel-input-container'>
                                    <div className='event-input-channel-wrapper'>
                                        {isLoading ? (
                                            <Skeleton className='skeleton-dropdown'>
                                                <SkeletonItem />
                                            </Skeleton>
                                        ) : (
                                            <Combobox
                                                placeholder='Select a channel'
                                                onChange={onInputChannelAction}
                                                onOpenChange={(event, data) => {
                                                    if (data.open && selectedChannelText === '') {
                                                        loadMyChannels();
                                                    }
                                                }}
                                                onOptionSelect={onSelectChannelOption}
                                                value={selectedChannelText}
                                            >
                                                {channelsAutocomplete.map((option) => (
                                                    <Option
                                                        key={option.id}
                                                        text={option.id}
                                                    >
                                                        {option.display_name}
                                                    </Option>
                                                ))}

                                                {channelsAutocomplete.length === 0 ? (
                                                    <Option
                                                        key='no-results'
                                                        text=''
                                                    >
                                                        No results found
                                                    </Option>
                                                ) : null}
                                            </Combobox>
                                        )}
                                    </div>
                                </div>
                            </div>

                            {/* the mention only takes effect in a channel post,
                                so it's pointless without a channel — and an
                                all-day event never posts one at all */}
                            {!isLoading && !selectedAllDay && Object.keys(selectedChannel).length !== 0 ? (
                                <MentionSelect
                                    selected={selectedMention}
                                    onSelected={(selected) => setSelectedMention(selected)}
                                />
                            ) : null}

                            {
                                isLoading ?
                                    <Skeleton className='skeleton-dropdown'>
                                        <SkeletonItem />
                                    </Skeleton>
                                    :
                                    <EventTypeSelect
                                        selected={selectedType}
                                        callColor={settings.callColor}
                                        eventColor={settings.eventColor}
                                        onSelected={(selected) => {
                                            setSelectedType(selected);
                                            if (selectedEvent?.event?.id == null) {
                                                applyTypeDefaults(selected);
                                            }
                                        }}
                                    />
                            }

                            {/* visibility is pinned to "team" for now (DEFAULT_VISIBILITY);
                                uncomment to let users pick private/channel/team again
                            {
                                isLoading ?
                                    <Skeleton className='skeleton-dropdown'>
                                        <SkeletonItem />
                                    </Skeleton>
                                    :
                                    <VisibilitySelect
                                        selected={selectedVisibility}
                                        onSelected={(selected) => setSelectedVisibility(selected)}
                                    />
                            }
                            */}

                            {
                                selectedAllDay ? null : (
                                    isLoading ?
                                        <Skeleton className='skeleton-dropdown'>
                                            <SkeletonItem />
                                        </Skeleton>
                                        :
                                        <EventAlertSelect
                                            selected={selectedAlert}
                                            onSelected={(selected) => {
                                                alertTouchedRef.current = true;
                                                setSelectedAlert(selected);
                                            }}
                                        />
                                )
                            }

                            <div className='event-add-users-container'>
                                <PersonAdd24Regular />
                                <div className='event-input-container'>
                                    <div className='event-input-users-wrapper'>
                                        {isLoading ? (<Skeleton className='skeleton-dropdown'>
                                            <SkeletonItem />
                                        </Skeleton>) : (<Combobox
                                            placeholder='Select a user'
                                            checked={false}
                                            selectedOptions={[]}
                                            onChange={onInputUserAction}
                                            onOpenChange={(event, data) => {
                                                if (data.open && searchUsersInput === '') {
                                                    loadUserOptions();
                                                }
                                            }}
                                            onOptionSelect={(event, data) => {
                                                const channelRequest = data.optionValue in usersMentionTags ? chooseAllUsersFromChannel() : undefined;
                                                usersAutocomplete.map((user) => {
                                                    if (user.id === data.optionValue && !usersAddedInEvent.some((u) => u.id === data.optionValue)) {
                                                        dispatch(updateMembersAddedInEvent([...usersAddedInEvent, user]));
                                                    }
                                                });
                                                userSearchRequest.current += 1;
                                                setSearchUsersInput('');
                                                setUsersAutocomplete([]);
                                                return channelRequest;
                                            }}
                                            value={searchUsersInput}
                                        >
                                            <OptionGroup label='USERS'>

                                                {usersAutocomplete.map((user) => {
                                                    let stat = 'unknown';
                                                    if (UserStatusSelector[user.id] === 'online') {
                                                        stat = 'available';
                                                    }
                                                    return (<Option text={user.id}>
                                                        <Persona
                                                            name={getDisplayUserName(user)}
                                                            className='user-list-item'
                                                            as='div'
                                                            presence={{ status: stat }}
                                                        />
                                                    </Option>);
                                                })}

                                                {usersAutocomplete.length === 0 ? (
                                                    <Option
                                                        key='no-results'
                                                        text=''
                                                    >
                                                        No results found
                                                    </Option>
                                                ) : null}
                                            </OptionGroup>
                                            <OptionGroup label='CHANNEL'>
                                                {
                                                    Object.entries(usersMentionTags).map(([key, value]) => {
                                                        return (<Option
                                                            key={key}
                                                            value={key}
                                                            text={value}
                                                            className='event-channel-users-action'
                                                            disabled={!selectedChannel.id || isLoadingChannelMembers}
                                                            title={!selectedChannel.id ? 'Select a channel first' : undefined}
                                                        >
                                                            {isLoadingChannelMembers ? <Spinner size='tiny' /> : <PersonAdd24Regular aria-hidden='true' />}
                                                            {value}
                                                        </Option>);
                                                    })
                                                }
                                            </OptionGroup>
                                        </Combobox>)}

                                    </div>
                                </div>
                            </div>
                            <div className='users-added-container'>
                                <UsersAddedComponent />
                            </div>

                            <div className='event-description-container'>
                                <TextDescription24Regular />
                                <div className='event-description-input-container'>
                                    {isLoading ? (<Skeleton className='event-description-input-textarea'><SkeletonItem /></Skeleton>) :
                                        <Textarea
                                            placeholder='Add description'
                                            className='event-description-input-textarea'
                                            resize='none'
                                            value={descriptionEvent}
                                            onChange={(event, data) => setDescriptionEvent(data.value)}
                                        />}
                                </div>

                            </div>

                            {selectedType === EVENT_TYPE_CALL ? (
                                <div className='event-meeting-link-container'>
                                    <Video24Regular />
                                    <div className='event-meeting-link-input-container'>
                                        {isLoading ? (<Skeleton className='skeleton-dropdown'><SkeletonItem /></Skeleton>) : (
                                            <>
                                                {/* editable so a link from any
                                                    provider can be pasted in,
                                                    not just a generated Jitsi one */}
                                                <Input
                                                    type='text'
                                                    inputMode='url'
                                                    className='event-meeting-link-input'
                                                    placeholder='Paste a meeting link or generate one'
                                                    value={meetingLink}
                                                    onChange={(event, data) => setMeetingLink(data.value)}
                                                />
                                                <Button
                                                    appearance='secondary'
                                                    className='event-meeting-link-button'
                                                    onClick={onGenerateMeetingLink}
                                                >
                                                    {'Generate Talk link'}
                                                </Button>
                                            </>
                                        )}
                                    </div>
                                </div>
                            ) : null}
                            <Toaster toasterId={toasterId} />
                        </DialogContent>
                        <RemoveEventButton />
                        <DialogActions
                            position='end'
                            className='event-modal-actions event-modal-actions-end'
                        >
                            <DialogTrigger disableButtonEnhancement={true}>
                                <Button
                                    appearance='secondary'
                                    onClick={viewEventModalHandleClose}
                                >
                                    {'Close'}
                                </Button>
                            </DialogTrigger>

                            <Button
                                appearance='primary'
                                onClick={onSaveEvent}
                                icon={isSaving ? (<Spinner size='tiny' />) : (<Save16Regular />)}
                                disabled={isSaving || !hasTitle}
                                title={hasTitle ? undefined : 'Add a title first'}
                            >
                                {'Save'}
                            </Button>

                        </DialogActions>
                    </DialogBody>
                </DialogSurface>
            </Dialog>
        </div>

    );
};

export default EventModalComponent;
