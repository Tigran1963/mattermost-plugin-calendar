package main

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/jmoiron/sqlx"
	"github.com/mattermost/mattermost-server/v6/model"
	"github.com/mattermost/mattermost-server/v6/plugin"
	"github.com/mattermost/mattermost-server/v6/plugin/plugintest"
	"github.com/stretchr/testify/require"
)

func TestAllDayDatesAcrossSubscribersAndLegacyStorage(t *testing.T) {
	moscow, err := time.LoadLocation("Europe/Moscow")
	require.NoError(t, err)
	start := time.Date(2026, 10, 23, 0, 0, 0, 0, moscow).UTC()
	for _, test := range []struct {
		name, savedZone string
		start, end      time.Time
		ownerZone       string
	}{
		{"new web event", "Europe/Moscow", start, start.AddDate(0, 0, 1), "America/New_York"},
		{"legacy web event", "", start, start.AddDate(0, 0, 1), "Europe/Moscow"},
		{"legacy CalDAV event", "", time.Date(2026, 10, 23, 0, 0, 0, 0, time.UTC), time.Date(2026, 10, 24, 0, 0, 0, 0, time.UTC), "America/New_York"},
	} {
		t.Run(test.name, func(t *testing.T) {
			api := &plugintest.API{}
			if test.name == "legacy web event" {
				api.On("GetUser", "owner").Return(&model.User{Timezone: map[string]string{"manualTimezone": test.ownerZone}}, nil).Once()
			}
			db, mock, err := sqlmock.New()
			require.NoError(t, err)
			defer db.Close()
			p := &Plugin{MattermostPlugin: plugin.MattermostPlugin{API: api}, DB: sqlx.NewDb(db, "sqlmock")}
			backend := NewCalDAVBackend(p, "subscriber", "token", "")
			mock.ExpectQuery("SELECT .*all_day_timezone.*FROM calendar_events.*").WithArgs("event").WillReturnRows(
				sqlmock.NewRows([]string{"id", "owner", "dt_start", "dt_end", "all_day", "all_day_timezone"}).AddRow("event", "owner", test.start, test.end, true, test.savedZone))
			event, err := backend.getEventByID("event")
			require.NoError(t, err)
			for _, viewerZone := range []string{"America/New_York", "Europe/Moscow", "Pacific/Kiritimati", "UTC"} {
				viewer := &model.User{Timezone: map[string]string{"manualTimezone": viewerZone}}
				for name, content := range map[string]string{
					"feed":   p.generateICalendar([]Event{*event}, viewer),
					"caldav": backend.eventToICalendarString(event, viewer),
				} {
					require.Contains(t, content, "DTSTART;VALUE=DATE:20261023", name+viewerZone)
					require.Contains(t, content, "DTEND;VALUE=DATE:20261024", name+viewerZone)
				}
			}
			raw, err := json.Marshal(event)
			require.NoError(t, err)
			require.Contains(t, string(raw), `"start":"2026-10-23"`)
			require.Contains(t, string(raw), `"end":"2026-10-24"`)
			require.NoError(t, mock.ExpectationsWereMet())
			api.AssertExpectations(t)
		})
	}
}

func TestEventDateJSONAndSavingTimezone(t *testing.T) {
	loc, err := time.LoadLocation("Europe/Moscow")
	require.NoError(t, err)
	for _, allDay := range []bool{false, true} {
		t.Run(map[bool]string{false: "timed", true: "all-day"}[allDay], func(t *testing.T) {
			event := Event{Visibility: VisibilityTeam, AllDay: allDay, Start: time.Date(2026, 10, 23, 0, 0, 0, 0, time.UTC), End: time.Date(2026, 10, 24, 0, 0, 0, 0, time.UTC)}
			setEventTimezone(&event, loc)
			require.Equal(t, 21, event.Start.Hour())
			require.Equal(t, 22, event.Start.Day())
			if allDay {
				require.Equal(t, "Europe/Moscow", event.AllDayTimezone)
			} else {
				require.Empty(t, event.AllDayTimezone)
			}
			raw, err := json.Marshal(event)
			require.NoError(t, err)
			var decoded Event
			require.NoError(t, json.Unmarshal(raw, &decoded))
			if allDay {
				require.Contains(t, string(raw), `"start":"2026-10-23"`)
			} else {
				require.True(t, event.Start.Equal(decoded.Start))
			}
			require.NotContains(t, string(raw), "all_day_timezone")
		})
	}
	var event Event
	require.Error(t, json.Unmarshal([]byte(`{"allDay":false,"start":"2026-10-23"}`), &event))
	require.Error(t, json.Unmarshal([]byte(`{"allDay":true,"start":"2026-02-30"}`), &event))
	require.NoError(t, json.Unmarshal([]byte(`{"allDay":true,"start":"2026-10-23","end":"2026-10-24"}`), &event))
	require.Equal(t, 23, event.Start.Day())
	require.NoError(t, json.Unmarshal([]byte(`{"allDay":true,"start":"2026-10-23T00:00:00Z","end":"2026-10-24T00:00:00Z"}`), &event))
	require.Equal(t, 23, event.Start.Day())
	event.AllDayTimezone = "invalid/timezone"
	require.Error(t, (&Plugin{}).normalizeAllDay(&event))
}

func TestAllDayRecurrencesKeepCivilDatesAcrossDST(t *testing.T) {
	loc, err := time.LoadLocation("America/New_York")
	require.NoError(t, err)
	event := Event{AllDay: true,
		Start: time.Date(2026, 2, 1, 0, 0, 0, 0, loc), End: time.Date(2026, 2, 3, 0, 0, 0, 0, loc),
	}
	for _, monthDay := range []struct {
		month time.Month
		day   int
	}{{time.March, 7}, {time.October, 31}} {
		occurrence := occurrenceOnDate(event, time.Date(2026, monthDay.month, monthDay.day, 0, 0, 0, 0, loc))
		require.Equal(t, 0, occurrence.End.Hour())
		require.Equal(t, occurrence.Start.AddDate(0, 0, 2).Format("2006-01-02"), occurrence.End.Format("2006-01-02"))
		viewer, err := time.LoadLocation("Pacific/Kiritimati")
		require.NoError(t, err)
		first := time.Date(2026, monthDay.month, monthDay.day, 0, 0, 0, 0, viewer)
		last := first.AddDate(0, 0, 1)
		require.True(t, allDayOverlaps(occurrence, first, last, viewer))
		require.False(t, allDayOverlaps(occurrence, last.AddDate(0, 0, 1), last.AddDate(0, 0, 2), viewer))
		lower, upper := allDayRecurrenceBounds(event, first, last, viewer)
		require.False(t, occurrence.Start.Before(lower))
		require.True(t, occurrence.Start.Before(upper))
	}
}
