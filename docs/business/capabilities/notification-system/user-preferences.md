# Capability: User Preferences

## Description

Stores per-user notification preferences as a JSON blob. Channels: `inApp`, `webPush`, `sound`. Events: `actionRequired`, `stop`, `error`. The user can toggle any combination from Settings → Notifications.

## Actors

- **End user** — Toggles channels and events.
- **The orchestrator** — Reads the preferences on every event.
- **`user_notification_preferences` table** — Persistence.

## Trigger

- The user opens Settings → Notifications and toggles a channel or event.
- The orchestrator reads the preferences on every event.

## Flow (Save)

1. The user opens Settings → Notifications.
2. The user toggles channels and events.
3. The frontend POSTs the preferences to the server.
4. The preferences are written to `user_notification_preferences` (per user).

## Flow (Read)

1. The orchestrator loads the preferences from the table.
2. The event is checked against the preferences.
3. The event is dispatched (or not) accordingly.

## Output

- A stored preferences blob per user.
- A consistent gate for every event.

## Technical Mapping

- **Backend repo:** `server/modules/database/repositories/notification-preferences.ts`
- **Backend routes:** `server/routes/settings.js`
- **Frontend UI:** `src/components/settings/view/tabs/NotificationsSettingsTab.tsx`

## Dependencies

- **Notification System** — Event orchestration.
- **Database Layer** — `user_notification_preferences` table.
