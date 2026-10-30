import React from 'react';
import {CalendarLtr24Regular} from '@fluentui/react-icons';
import {DispatchFunc} from 'mattermost-redux/types/actions';

import {PluginRegistry} from './types/mattermost-webapp';
import {id as PluginId} from './manifest';
import CalendarSidebar from './components/calendar-sidebar';
import getSiteURL from './components/utils';

export function registerCalendarSidebar(registry: PluginRegistry, dispatch: DispatchFunc): void {
    const Sidebar = () => <CalendarSidebar onOpenCalendar={() => dispatch(sidebar.hideRHSPlugin)}/>;
    // The sidebar shares the main window's event editor and Redux state.
    const sidebar = registry.registerRightHandSidebarComponent(Sidebar, 'Calendar', false);
    const toggle = () => dispatch(sidebar.toggleRHSPlugin);
    if (registry.registerAppBarComponent) {
        registry.registerAppBarComponent(
            `${getSiteURL()}/plugins/${PluginId}/public/calendar.svg`,
            toggle,
            'Calendar',
            null,
        );
    }
    // Mattermost uses this entry on mobile and when the App Bar is disabled.
    registry.registerChannelHeaderButtonAction?.(<CalendarLtr24Regular/>, toggle, 'Calendar', 'Open calendar sidebar');
}
