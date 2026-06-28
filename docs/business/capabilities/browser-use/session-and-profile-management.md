# Capability: Session & Profile Management

## Description

Each browser-use run is a Playwright session. Sessions are capped per owner (`MAX_SESSIONS_PER_OWNER=3`) and auto-stopped on staleness (30 min TTL). Profiles are persistent per-name directories under `~/.cloudcli/browser-use/profiles` so cookies and storage survive across sessions.

## Actors

- **End user / agent** — Creates a session (with optional `profileName`).
- **The browser-use service** — Manages session lifecycle.
- **Playwright** — Provides `launchPersistentContext` for profile persistence.
- **The filesystem** — Holds the profile dirs.

## Trigger

- The agent calls `browser_create_session` (with optional `profileName`).
- The TTL elapses without activity.
- The agent or user calls `browser_close_session`.

## Flow (Create)

1. The agent calls `browser_create_session` with an optional `profileName`.
2. The service checks the per-owner cap; rejects if exceeded.
3. The service launches Playwright with `launchPersistentContext` against the profile dir (creating it if needed).
4. The service returns the `sessionId`.

## Flow (Idle TTL)

1. A session is idle (no calls) for 30 minutes.
2. The service auto-stops the session and frees the handle.
3. The next call returns "session not found".

## Flow (Close)

1. The agent or user calls `browser_close_session`.
2. The service closes the browser context and frees the handle.

## Output

- A live session per call.
- Persistent cookies and storage in the profile dir.
- No leaked browser processes.

## Technical Mapping

- **Backend service:** `server/modules/browser-use/browser-use.service.ts`
- **Profile storage:** `~/.cloudcli/browser-use/profiles/<name>`
- **MCP tools:** `browser_create_session`, `browser_list_sessions`, `browser_close_session`

## Dependencies

- **Browser-Use** — Runtime & installation.
- **Authentication & Security** — Per-owner scoping.
