# Capability: Event Orchestration

## Description

Central entry point for every notification event. The chat run lifecycle calls `notifyRunStopped` / `notifyRunFailed`; the orchestrator checks the user's preferences, applies a 20s dedupe window, normalizes the session id, and dispatches to the right channel(s) — in-app, web-push, and/or sound.

## Actors

- **The chat run lifecycle** — The caller.
- **The notification orchestrator** — The dispatcher.
- **The user's preferences** — Channel and event gates.
- **The dedupe window** — 20s per (user, event, session).

## Trigger

- A provider run ends (`notifyRunStopped`).
- A provider run fails (`notifyRunFailed`).
- A provider needs user action (`notifyUserIfEnabled`).

## Flow

1. The chat run lifecycle calls `notifyRunStopped(userId, sessionId)`.
2. The orchestrator loads the user's `notification_preferences`.
3. If the channel (`inApp`, `webPush`, `sound`) is not enabled for the event (`stop`), the call is dropped.
4. The orchestrator checks the 20s dedupe window for (user, event, session).
5. The session id is normalized to the stable app id.
6. The event is dispatched to the enabled channel(s).
7. The dedupe window is updated.

## Output

- A user notification (or none, if preferences or dedupe block it).
- A consistent dedupe and preference model.

## Technical Mapping

- **Backend service:** `server/services/notification-orchestrator.js`
- **Backend repo:** `server/modules/database/repositories/notification-preferences.ts`
- **Callers:** Provider runtimes (Claude, Cursor, Codex, Gemini, OpenCode) and `/api/agent`.

## Dependencies

- **Notification System** — VAPID & subscriptions, in-app / sound channels.
- **Database Layer** — `notification_preferences` table.
- **Session & Project Management** — Session id normalization.
