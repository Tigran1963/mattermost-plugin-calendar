package main

import (
	"regexp"
	"strings"
)

// Match the credential segment regardless of its length: rejected credentials
// and URLs embedded in XML must be redacted as well as valid request paths.
var calendarTokenURL = regexp.MustCompile(`(/caldav/|/ical/feed/)[^/\s<>"'?&#]+`)

func redactCalendarTokens(value string, tokens ...string) string {
	for _, token := range tokens {
		if token != "" {
			value = strings.ReplaceAll(value, token, "[REDACTED]")
		}
	}
	return calendarTokenURL.ReplaceAllString(value, "${1}[REDACTED]")
}

func (b *CalDAVBackend) redactedLogFields(fields []interface{}) []interface{} {
	redacted := make([]interface{}, len(fields))
	for i, value := range fields {
		if text, ok := value.(string); ok {
			redacted[i] = redactCalendarTokens(text, b.token)
		} else {
			redacted[i] = value
		}
	}
	return redacted
}

func (b *CalDAVBackend) logInfo(message string, fields ...interface{}) {
	b.plugin.API.LogInfo(redactCalendarTokens(message, b.token), b.redactedLogFields(fields)...)
}

func (b *CalDAVBackend) logError(message string, fields ...interface{}) {
	b.plugin.API.LogError(redactCalendarTokens(message, b.token), b.redactedLogFields(fields)...)
}

func (b *CalDAVBackend) logWarn(message string, fields ...interface{}) {
	b.plugin.API.LogWarn(redactCalendarTokens(message, b.token), b.redactedLogFields(fields)...)
}
