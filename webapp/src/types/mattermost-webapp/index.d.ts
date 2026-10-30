import React from 'react';
import {Reducer} from 'redux';
import {Action} from 'mattermost-redux/types/actions';

export interface PluginRegistry {
    registerPostTypeComponent(typeName: string, component: React.ElementType): string;
    registerReducer(reducer: Reducer): void;
    registerProduct(
        baseURL: string, switcherIcon: string, switcherText: string, switcherLinkURL: string,
        mainComponent: React.ElementType, headerCentreComponent: React.ElementType,
        headerRightComponent: React.ElementType, showTeamSidebar: boolean,
    ): string;
    registerWebSocketEventHandler(event: string, handler: (event: {data: {id: string; title: string; channel?: string}}) => void): void;
    registerRightHandSidebarComponent(component: React.ElementType, title: string, showPopout?: boolean): {
        id: string;
        showRHSPlugin: Action;
        hideRHSPlugin: Action;
        toggleRHSPlugin: Action;
    };
    registerAppBarComponent?(iconUrl: string, action: () => unknown, tooltipText: string, supportedProductIds?: string | null): string;
    registerChannelHeaderButtonAction?(icon: React.ReactNode, action: () => unknown, dropdownText: string, tooltipText: string): string;
}
