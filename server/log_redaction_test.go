package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/mattermost/mattermost-server/v6/plugin"
	"github.com/mattermost/mattermost-server/v6/plugin/plugintest"
	"github.com/stretchr/testify/assert"
)

func TestRedactCalendarTokens(t *testing.T) {
	token := strings.Repeat("a1", 32)
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{"feed", "/ical/feed/" + token, "/ical/feed/[REDACTED]"},
		{"feed invalid token", "/ical/feed/short", "/ical/feed/[REDACTED]"},
		{"caldav event", "/plugins/com.dmkir.calendar/caldav/" + token + "/calendar/event.ics", "/plugins/com.dmkir.calendar/caldav/[REDACTED]/calendar/event.ics"},
		{"caldav invalid token", "/caldav/invalid%20token/", "/caldav/[REDACTED]/"},
		{"feed query", "https://example.com/ical/feed/" + token + "?format=ical", "https://example.com/ical/feed/[REDACTED]?format=ical"},
		{"XML request", `<d:href>/caldav/` + token + `/calendar/event.ics</d:href><d:href>https://example.com/ical/feed/other-secret</d:href>`, `<d:href>/caldav/[REDACTED]/calendar/event.ics</d:href><d:href>https://example.com/ical/feed/[REDACTED]</d:href>`},
		{"token settings endpoint", "/ical/token", "/ical/token"},
		{"empty credential", "/caldav/", "/caldav/"},
		{"unrelated path", "/events/event-id", "/events/event-id"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			assert.Equal(t, test.want, redactCalendarTokens(test.input))
		})
	}
	assert.Equal(t, "credential=[REDACTED]", redactCalendarTokens("credential="+token, token))
	assert.Equal(t, "unchanged", redactCalendarTokens("unchanged", ""))
}

func TestCalDAVLoggingRedactsTokenInAllStringFields(t *testing.T) {
	token := strings.Repeat("a1", 32)
	api := &plugintest.API{}
	api.On("LogInfo", "request [REDACTED]", "body", "<secret>[REDACTED]</secret>", "count", 2).Return().Once()
	api.On("LogError", "failed /caldav/[REDACTED]/", "error", "credential=[REDACTED]").Return().Once()
	api.On("LogWarn", "unknown", "value", "/ical/feed/[REDACTED]").Return().Once()
	p := &Plugin{MattermostPlugin: plugin.MattermostPlugin{API: api}}
	b := NewCalDAVBackend(p, "user", token, "")
	fields := []interface{}{"body", "<secret>" + token + "</secret>", "count", 2}
	b.logInfo("request "+token, fields...)
	b.logError("failed /caldav/"+token+"/", "error", "credential="+token)
	b.logWarn("unknown", "value", "/ical/feed/other-secret")
	assert.Equal(t, "<secret>"+token+"</secret>", fields[1], "logging must not modify request data")
	api.AssertExpectations(t)
}

func TestCalDAVPropfindLogsRedactedPathsAndBodyWithoutChangingResponse(t *testing.T) {
	token := strings.Repeat("a1", 32)
	requestPath := "/plugins/" + PluginId + "/caldav/" + token + "/"
	body := `<d:propfind xmlns:d="DAV:"><d:href>` + requestPath + `</d:href></d:propfind>`
	redactedPath := "/plugins/" + PluginId + "/caldav/[REDACTED]/"
	redactedBody := `<d:propfind xmlns:d="DAV:"><d:href>` + redactedPath + `</d:href></d:propfind>`
	api := &plugintest.API{}
	api.On("LogInfo", "CalDAV request", "method", "PROPFIND", "path", redactedPath).Return().Once()
	api.On("LogInfo", "CalDAV PROPFIND", "path", redactedPath, "depth", "0", "body", redactedBody).Return().Once()
	api.On("LogInfo", "CalDAV PROPFIND routing", "isRoot", true, "isCalendar", false, "depth", "0").Return().Once()
	p := &Plugin{MattermostPlugin: plugin.MattermostPlugin{API: api}}
	b := NewCalDAVBackend(p, "user", token, "")
	response := b.rootPropfindResponse()
	api.On("LogInfo", "CalDAV PROPFIND response length", "length", len(response)).Return().Once()
	r := httptest.NewRequest("PROPFIND", requestPath, strings.NewReader(body))
	r.Header.Set("Depth", "0")
	w := httptest.NewRecorder()
	b.ServeHTTP(w, r)
	assert.Equal(t, http.StatusMultiStatus, w.Code)
	assert.Contains(t, w.Body.String(), requestPath, "response URLs must retain the credential")
	assert.Equal(t, requestPath, r.URL.Path, "logging must not modify the actual request path")
	api.AssertExpectations(t)
}
