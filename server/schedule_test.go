package main

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/jmoiron/sqlx"
	"github.com/mattermost/mattermost-server/v6/model"
	"github.com/mattermost/mattermost-server/v6/plugin"
	"github.com/mattermost/mattermost-server/v6/plugin/plugintest"
	"github.com/stretchr/testify/require"
)

func TestScheduleAllDayAcrossTimezonesAndDST(t *testing.T) {
	api := &plugintest.API{}
	user := &model.User{Id: "user", Timezone: map[string]string{"manualTimezone": "America/New_York"}}
	api.On("GetSession", "session").Return(&model.Session{UserId: user.Id}, nil)
	api.On("GetUser", user.Id).Return(user, nil)
	api.On("GetTeamsForUser", user.Id).Return([]*model.Team{}, nil)
	db, mock, err := sqlmock.New()
	require.NoError(t, err)
	defer db.Close()
	mock.MatchExpectationsInOrder(false)
	moscow, err := time.LoadLocation("Europe/Moscow")
	require.NoError(t, err)
	mock.ExpectQuery("SELECT ce.id.*FROM calendar_events").WillReturnRows(
		sqlmock.NewRows([]string{"id", "owner", "dt_start", "dt_end", "all_day", "all_day_timezone", "visibility"}).AddRow(
			"event", user.Id, time.Date(2026, 11, 1, 0, 0, 0, 0, moscow).UTC(), time.Date(2026, 11, 3, 0, 0, 0, 0, moscow).UTC(), true, "Europe/Moscow", "private"))
	mock.ExpectQuery("SELECT ChannelId FROM ChannelMembers").WithArgs(user.Id).WillReturnRows(sqlmock.NewRows([]string{"ChannelId"}))
	p := &Plugin{MattermostPlugin: plugin.MattermostPlugin{API: api}, DB: sqlx.NewDb(db, "sqlmock")}
	request := httptest.NewRequest("GET", "/schedule?users=user&start=2026-11-01T00:00:00&end=2026-11-02T00:00:00", nil)
	request = request.WithContext(context.WithValue(request.Context(), "pluginRequest", &plugin.Context{SessionId: "session"}))
	response := httptest.NewRecorder()
	p.GetSchedule(response, request)
	require.Equal(t, 200, response.Code)
	var result struct {
		Data GetScheduleResponse `json:"data"`
	}
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &result))
	require.Empty(t, result.Data.AvailableTimes, "all slots must be busy without overflowing on a multi-day DST event")
	require.Len(t, result.Data.Users[user.Id], 1)
	require.Equal(t, "2026-11-01T00:00:00-04:00", result.Data.Users[user.Id][0].Start.Format(time.RFC3339))
	require.NoError(t, mock.ExpectationsWereMet())
	api.AssertExpectations(t)
}
