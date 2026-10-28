# Calendar date and picker fixes

The plugin applies migration 16 at activation on both PostgreSQL and MySQL. It
adds `calendar_events.all_day_timezone`; existing timestamps are not rewritten.
New all-day events record the saving user's Mattermost timezone. iCal, CalDAV,
and the web calendar use the event's dates independently of the viewer's zone.
The end date remains exclusive. All-day API responses use `YYYY-MM-DD`; event
writes accept both dates and the editor's existing timestamp format.

For existing all-day events without a saved zone:

- UTC-midnight ranges retain their UTC dates, preserving old CalDAV DATE values.
- Other ranges are interpreted in the author's current Mattermost timezone.

The original zone cannot be recovered from old records if the author changed it
or another person last changed the dates in a different zone. Such events need
their dates checked and saved once; saving records the timezone for future use.

Subscription URLs remain unchanged. CalDAV all-day ETags change so clients fetch
the corrected representation on their next refresh. Historical log entries are
not rewritten; new request logs redact subscription tokens.

Picker regression checks: `cd webapp && npm run test:pickers` (Node.js 18+).
Server regression checks: `go test -race ./...`.
