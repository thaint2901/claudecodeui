# Capability: VAPID & Subscriptions

## Description

Generates the VAPID key pair on first use (or loads it from the `vapid_keys` table), wires it into the `web-push` library at startup, and manages browser push subscription endpoints per user. Endpoints that return 404 or 410 are pruned automatically.

## Actors

- **The browser** — Subscribes to push via the Push API.
- **The VAPID service** — Generates / loads the keypair.
- **`web-push`** — The library that signs and sends notifications.
- **`vapid_keys` and `push_subscriptions` tables** — Persistence.

## Trigger

- The server boots (VAPID keypair is loaded and wired).
- The user enables web-push in Settings (subscription is saved).
- A push delivery returns 404 or 410 (subscription is pruned).

## Flow (Bootstrap)

1. The server boots.
2. The VAPID service calls `vapidKeysDb.getOrCreate`.
3. If a keypair exists, it's loaded; otherwise, a new one is generated and persisted.
4. `webPush.setVapidDetails(subject, publicKey, privateKey)` is called.

## Flow (Subscribe)

1. The user enables web-push in Settings.
2. The browser requests the VAPID public key from `/api/settings/vapid-public-key`.
3. The browser subscribes via the Push API and POSTs the subscription to the server.
4. The subscription is stored in `push_subscriptions` (unique on `endpoint`).

## Flow (Prune)

1. A push delivery returns 404 or 410.
2. The orchestrator deletes the subscription row.

## Output

- A ready VAPID keypair for the install.
- A list of live browser subscriptions per user.
- No dead subscriptions accumulating.

## Technical Mapping

- **Backend service:** `server/services/vapid-keys.js`
- **Backend repos:** `server/modules/database/repositories/vapid-keys.ts`, `push-subscriptions.ts`
- **Routes:** `server/routes/settings.js`

## Dependencies

- **Database Layer** — `vapid_keys` and `push_subscriptions` tables.
- **Notification System** — All other capabilities.
