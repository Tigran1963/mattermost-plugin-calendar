package main

import (
	"encoding/json"
	"fmt"
	"time"
)

// normalizeAllDay restores the event's own timezone, never the subscriber's.
// Old CalDAV DATE values were stored at UTC midnight; old web events were
// stored as local midnight converted to UTC, without recording their timezone.
func (p *Plugin) normalizeAllDay(event *Event) error {
	if !event.AllDay {
		return nil
	}
	zone := event.AllDayTimezone
	if zone == "" {
		if utcMidnight(event.Start) && utcMidnight(event.End) {
			zone = "UTC"
		} else {
			owner, err := p.API.GetUser(event.Owner)
			if err != nil || owner == nil {
				return fmt.Errorf("cannot resolve timezone for all-day event %s", event.Id)
			}
			zone = p.GetUserLocation(owner).String()
		}
	}
	loc, err := time.LoadLocation(zone)
	if err != nil {
		return fmt.Errorf("invalid timezone for all-day event %s: %w", event.Id, err)
	}
	event.AllDayTimezone = zone
	event.Start = event.Start.In(loc)
	event.End = event.End.In(loc)
	return nil
}

func utcMidnight(date time.Time) bool {
	date = date.UTC()
	return date.Hour() == 0 && date.Minute() == 0 && date.Second() == 0 && date.Nanosecond() == 0
}

// All-day JSON dates have no offset for browsers or FullCalendar to convert.
func (event Event) MarshalJSON() ([]byte, error) {
	type plainEvent Event
	if !event.AllDay {
		return json.Marshal(plainEvent(event))
	}
	if event.AllDayTimezone != "" {
		loc, err := time.LoadLocation(event.AllDayTimezone)
		if err != nil {
			return nil, err
		}
		event.Start = event.Start.In(loc)
		event.End = event.End.In(loc)
	}
	return json.Marshal(struct {
		plainEvent
		Start string `json:"start"`
		End   string `json:"end"`
	}{plainEvent(event), event.Start.Format("2006-01-02"), event.End.Format("2006-01-02")})
}

// Accept both DATE responses and the timestamp form sent by the event editor.
func (event *Event) UnmarshalJSON(data []byte) error {
	type plainEvent Event
	decoded := struct {
		*plainEvent
		Start string `json:"start"`
		End   string `json:"end"`
	}{plainEvent: (*plainEvent)(event)}
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}
	for _, field := range []struct {
		value  string
		target *time.Time
	}{
		{decoded.Start, &event.Start}, {decoded.End, &event.End},
	} {
		if field.value == "" {
			continue
		}
		value, err := time.Parse(time.RFC3339Nano, field.value)
		if err != nil && event.AllDay {
			value, err = time.Parse("2006-01-02", field.value)
		}
		if err != nil {
			return err
		}
		*field.target = value
	}
	return nil
}

// The editor sends wall-clock fields; interpret them once in the saving user's
// timezone and persist that source zone for all-day dates.
func setEventTimezone(event *Event, loc *time.Location) {
	event.AllDayTimezone = ""
	if event.AllDay {
		event.AllDayTimezone = loc.String()
	}
	for _, date := range []*time.Time{&event.Start, &event.End} {
		*date = time.Date(date.Year(), date.Month(), date.Day(), date.Hour(), date.Minute(), date.Second(), date.Nanosecond(), loc).UTC()
	}
}

// Compare civil dates in the requested calendar range, not midnight instants
// from two different timezones. SQL admits a small margin for this conversion.
func allDayOverlaps(event Event, start, end time.Time, viewer *time.Location) bool {
	if viewer == nil {
		viewer = time.UTC
	}
	return event.End.Format("2006-01-02") > start.In(viewer).Format("2006-01-02") &&
		event.Start.Format("2006-01-02") < end.In(viewer).Format("2006-01-02")
}

func occurrenceOnDate(event Event, date time.Time) Event {
	duration := event.End.Sub(event.Start)
	startDay := time.Date(event.Start.Year(), event.Start.Month(), event.Start.Day(), 0, 0, 0, 0, time.UTC)
	endDay := time.Date(event.End.Year(), event.End.Month(), event.End.Day(), 0, 0, 0, 0, time.UTC)
	event.Start = time.Date(date.Year(), date.Month(), date.Day(), event.Start.Hour(), event.Start.Minute(), event.Start.Second(), event.Start.Nanosecond(), event.Start.Location())
	if event.AllDay {
		event.End = event.Start.AddDate(0, 0, int(endDay.Sub(startDay)/(24*time.Hour)))
	} else {
		event.End = event.Start.Add(duration)
	}
	return event
}

func allDayRecurrenceBounds(event Event, start, end time.Time, viewer *time.Location) (time.Time, time.Time) {
	if viewer == nil {
		viewer = time.UTC
	}
	inSource := func(date time.Time) time.Time {
		date = date.In(viewer)
		return time.Date(date.Year(), date.Month(), date.Day(), 0, 0, 0, 0, event.Start.Location())
	}
	first := time.Date(event.Start.Year(), event.Start.Month(), event.Start.Day(), 0, 0, 0, 0, time.UTC)
	last := time.Date(event.End.Year(), event.End.Month(), event.End.Day(), 0, 0, 0, 0, time.UTC)
	days := int(last.Sub(first) / (24 * time.Hour))
	return inSource(start).AddDate(0, 0, -days), inSource(end)
}
