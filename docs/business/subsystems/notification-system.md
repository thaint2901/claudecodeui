# Subsystem 10: Notification System

## Business Purpose

The **Notification System** delivers **per-user web-push notifications** for chat run lifecycle events, plus **in-app toasts** and **sound cues**. It manages VAPID keys, browser push subscriptions, and per-user notification preferences (channels and event kinds).

The user can subscribe once and be notified on any device when a run finishes, errors, or needs their attention — even when the app is closed.

## Key Capabilities

| Capability | Description |
|------------|-------------|
| **VAPID key bootstrap** | Generate on first use (or load from `vapid_keys`); cached in memory; calls `webPush.setVapidDetails` on startup |
| **Notification event factory** | Single entry point for `notifyUserIfEnabled`, `notifyRunStopped`, `notifyRunFailed` |
| **Per-kind/per-channel preferences** | Channels: `inApp`, `webPush`, `sound`; events: `actionRequired`, `stop`, `error` |
| **20s event dedupe window** | Prevents the same event firing twice in quick succession |
| **Session id normalization** | Provider-native id → app-facing id before sending |
| **Web-push delivery** | Sends JSON payload to all per-user subscriptions; prunes 404/410 endpoints |
| **In-app delivery** | Surfaces as a toast in the UI |
| **Sound delivery** | Plays a sound when the user is in the app (gated by `sound` preference) |
| **Service worker `push` handler** | Icon `/logo-256.png`, badge `/logo-128.png`, session-scoped tag |
| **Service worker `notificationclick` handler** | Focuses or opens `/session/<id>` and posts `notification:navigate` |
| **Subscription management** | Save / delete browser push subscription endpoints |
| **Settings UI** | Notifications settings tab in Settings |

## Notification Events

| Event | When | Default Channels |
|-------|------|------------------|
| `actionRequired` | Provider emits a permission request | inApp + webPush + sound |
| `stop` | Run completes successfully | inApp + webPush |
| `error` | Run fails or crashes | inApp + webPush + sound |

## Stakeholders

| Stakeholder | What They Get |
|-------------|---------------|
| **End users** | A way to know when a long-running task finishes or needs their attention. |
| **Mobile users** | Native-feeling notifications via the PWA + web-push. |
| **Operators** | Configurable preferences; auto-cleaned dead subscriptions. |
| **The chat run lifecycle** | A single hook (`notifyRunStopped` / `notifyRunFailed`) to call when a run ends. |

## How a Web-Push Is Sent

1. A provider run ends; the runtime calls `notifyRunStopped(userId, sessionId)`.
2. The orchestrator looks up the user's `notification_preferences` JSON.
3. If `webPush` is enabled for the `stop` event, the orchestrator loads the VAPID keypair and queries `push_subscriptions` for the user.
4. The session id is normalized to the stable app id.
5. The orchestrator signs and sends the JSON payload to every subscription endpoint.
6. Endpoints that return 404 or 410 are pruned.
7. The service worker receives the `push` event and shows the notification.
8. On `notificationclick`, the service worker focuses the app and posts `notification:navigate` with the session id.

## Cross-Cutting Concerns

- **Dedupe** — 20s window prevents the same event from firing twice in quick succession (e.g. a stop and a permission request for the same session).
- **Session id** — Always normalized to the app id before sending so the click handler can route to the right session.
- **Cleanup** — 404/410 endpoints are pruned automatically.
- **VAPID caching** — Keypair is loaded once per boot; no per-send key derivation.
- **Preferences** — Per-user JSON blob; UI in Settings → Notifications.

## Technical Mapping (Entry Points)

- **VAPID service:** `server/services/vapid-keys.js`
- **Orchestrator:** `server/services/notification-orchestrator.js`
- **Repositories:** `server/modules/database/repositories/vapid-keys.ts`, `push-subscriptions.ts`, `notification-preferences.ts`
- **Routes:** `server/routes/settings.js` (subscribe/unsubscribe), `server/routes/user.js`
- **Service worker:** `public/sw.js`
- **Frontend settings tab:** `src/components/settings/view/tabs/NotificationsSettingsTab.tsx`
- **Sound playback:** `src/components/chat/` (in-app sound hook)

## Capability Documents

- [capabilities/notification-system/vapid-and-subscriptions.md](capabilities/notification-system/vapid-and-subscriptions.md)
- [capabilities/notification-system/event-orchestration.md](capabilities/notification-system/event-orchestration.md)
- [capabilities/notification-system/web-push-delivery.md](capabilities/notification-system/web-push-delivery.md)
- [capabilities/notification-system/in-app-and-sound-channels.md](capabilities/notification-system/in-app-and-sound-channels.md)
- [capabilities/notification-system/user-preferences.md](capabilities/notification-system/user-preferences.md)
