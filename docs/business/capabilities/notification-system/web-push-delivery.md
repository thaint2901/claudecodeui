# Capability: Web Push Delivery

## Description

Signs and sends the JSON payload to all per-user browser push subscriptions. Prunes 404 / 410 endpoints automatically. The service worker receives the `push` event, shows the notification (icon `/logo-256.png`, badge `/logo-128.png`, session-scoped tag), and handles the `notificationclick` (focuses or opens `/session/<id>` and posts `notification:navigate`).

## Actors

- **The orchestrator** — The caller.
- **`web-push`** — The library that signs and sends.
- **The browser's Push API** — Delivers to the service worker.
- **The service worker** — Shows the notification and handles clicks.

## Trigger

- The orchestrator decides to send a web-push.

## Flow

1. The orchestrator iterates the user's `push_subscriptions`.
2. For each, `webPush.sendNotification(subscription, payload)` is called.
3. The response is checked for 404 / 410; on hit, the subscription is pruned.
4. The browser's Push API receives the push and dispatches to the service worker.
5. The service worker shows the notification (or updates the existing one if the tag matches).
6. On `notificationclick`, the service worker focuses the app (or opens `/session/<id>`) and posts `notification:navigate`.

## Output

- A push notification shown on the user's device(s).
- A clean click handler that routes to the right session.
- (On 404/410) A pruned subscription.

## Technical Mapping

- **Backend service:** `server/services/notification-orchestrator.js`
- **Service worker:** `public/sw.js`
- **Library:** `web-push`

## Dependencies

- **Notification System** — VAPID & subscriptions, event orchestration.
- **Database Layer** — `push_subscriptions` table.
- **Distribution** — PWA service worker.
