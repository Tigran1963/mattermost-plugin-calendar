// 24px to match every other row icon in the event form; a 20px one shifts the
// field next to it by 4px
import {CalendarLtr24Regular} from '@fluentui/react-icons';
import {Combobox, InfoLabel, Option} from '@fluentui/react-components';
import React from 'react';

interface EventTypeSelectProps {
    selected: string;
    callColor: string;
    eventColor: string;
    onSelected: (selected: string) => void;
}

interface EventTypeOption {
    id: string;
    display_name: string;
}

const eventTypeOptions: Array<EventTypeOption> = [
    {id: 'call', display_name: 'Call'},
    {id: 'event', display_name: 'Event'},
];

const EventTypeSelect = (props: EventTypeSelectProps) => {
    const selectedOption = eventTypeOptions.find((option) => option.id === props.selected);
    const getColor = (type: string) => type === 'call' ? props.callColor : props.eventColor;

    return (
        <div className='event-visibility-container'>
            <CalendarLtr24Regular/>
            <div className='event-visibility-input-container'>
                <div className='event-input-visibility-wrapper event-type-picker'>
                    {selectedOption && (
                        <span
                            className='event-type-color-dot event-type-selected-dot'
                            style={{backgroundColor: getColor(selectedOption.id)}}
                            aria-hidden='true'
                        />
                    )}
                    <Combobox
                        placeholder='Select a calendar'
                        input={{className: selectedOption ? 'event-type-input-with-color' : undefined}}
                        selectedOptions={selectedOption ? [selectedOption.id] : []}
                        onOptionSelect={(event, data) => {
                            props.onSelected(data.optionValue!);
                        }}
                        value={selectedOption?.display_name || ''}
                    >
                        {eventTypeOptions.map((option) => (
                            <Option
                                key={option.id}
                                value={option.id}
                                text={option.display_name}
                            >
                                <span className='event-type-option'>
                                    <span
                                        className='event-type-color-dot'
                                        style={{backgroundColor: getColor(option.id)}}
                                        aria-hidden='true'
                                    />
                                    {option.display_name}
                                </span>
                            </Option>
                        ))}
                    </Combobox>
                </div>
            </div>
            <InfoLabel
                info={
                    <>
                        <p>Which calendar this belongs to. Calls and events are filtered separately in the toolbar and get their own colour in settings.</p>
                        <p>Only calls carry a video meeting link; events default to all day.</p>
                    </>
                }
            />
        </div>
    );
};

export default EventTypeSelect;
