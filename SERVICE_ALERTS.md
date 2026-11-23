# General app push notifications

The gateway supports an authenticated account-wide push endpoint:
`POST /api/v1/gateway/push-notifications`, using the normal `x-api-key` or bearer
authentication. All devices are selected from the authenticated account; the
request cannot supply another account or a target token. SMS gateway `enabled`
does not gate app notifications.

Required body fields are `id` (stable safe identifier), `category`, `title`
(1–160 characters), `body` (1–320), and `severity` (`issue`, `degraded`, `outage`,
`recovered`). Optional `url` must be HTTPS without credentials. Unknown fields
are rejected. Keep all fields safe for a phone notification; do not include
academic request/response bodies or learner data.

The endpoint directly uses Firebase with a 5-minute data-message expiry and
bypasses the SMS queue. It returns HTTP 202 with `data.accepted`, recipient counts,
and `delivered: false`. This means provider acceptance only. Transient partial
failures return 503 so the background caller can retry. Stale, unregistered tokens
do not block healthy receivers; a broadcast with no successful receiver fails.
Broadcasts support at most 500 registered push-capable devices per account.

Android 2.8.23 / versionCode 41 adds the `platform_alert` receiver and **Service
alerts** channel, sound/vibration, bounded duplicate suppression and safe HTTPS
incident links. Old receivers ignore this new command; update all intended phones.
Open the registered app once to grant notification permission on Android 13+.
Settings → Service alerts opens the OS channel controls. Permission, channel
settings and Do Not Disturb remain under the device user's control.

Gabay's reusable helper and fourteen-day diagnostic limits are documented in
`../api/SERVICE_STATUS.md`. Enable `PLATFORM_ALERT_PUSH_ENABLED=true` on Gabay API
and core workers only after the TextBee API and phone updates are deployed. It
uses the configured TextBee account key and requires no per-device recipient list.
