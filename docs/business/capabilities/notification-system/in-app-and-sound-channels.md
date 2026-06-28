# Capability: In-App & Sound Channels

## Description

Surfaces notifications in the app when the user is online. Two flavors: **in-app toasts** (a transient banner) and **sound cues** (a short audio clip). Both are gated by the user's notification preferences.

## Actors

- **The orchestrator** — The caller.
- **The frontend** — Renders the toast and plays the sound.

## Trigger

- The orchestrator decides to send an in-app notification.
- The orchestrator decides to play a sound.

## Flow (In-App Toast)

1. The orchestrator emits a `notification:show` event to the user's connected clients.
2. The frontend receives the event and renders a toast.
3. The toast auto-dismisses after a few seconds.
4. The user can click the toast to navigate to the session.

## Flow (Sound)

1. The orchestrator emits a `notification:play-sound` event to the user's connected clients.
2. The frontend receives the event and plays a short audio clip.
3. The user hears the sound while using the app.

## Output

- A user-visible (or audible) notification.
- A consistent preference model: in-app, web-push, and sound are all gated by the same preferences.

## Technical Mapping

- **Backend service:** `server/services/notification-orchestrator.js` (event dispatch)
- **Frontend consumer:** `src/components/chat/` (in-app sound hook)
- **Frontend toast:** `src/components/notification/`

## Dependencies

- **Notification System** — Event orchestration.
- **Database Layer** — `notification_preferences` table.
- **Distribution** — PWA service worker integration.
