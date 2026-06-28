# Capability: Graceful Shutdown

## Description

On host exit (`SIGTERM`, `SIGINT`, `beforeExit`), all live browser sessions are stopped, the Playwright browser contexts are closed, and no zombie Chromium processes are left running.

## Actors

- **The host server** — Receives the shutdown signal.
- **The browser-use service** — Stops all sessions.
- **Playwright** — Closes the browser context.

## Trigger

- `SIGTERM` or `SIGINT` is sent to the host process.
- The Node process is about to exit (`beforeExit`).

## Flow

1. The host's shutdown handler runs.
2. The browser-use service iterates all live sessions.
3. For each session, the Playwright browser context is closed.
4. The session handle is freed.
5. The host continues with the rest of the shutdown (plugins, sessions watcher, etc.).

## Output

- A clean exit.
- No leaked Chromium processes.
- No leaked file handles in the profile dirs.

## Technical Mapping

- **Backend service:** `server/modules/browser-use/browser-use.service.ts` (`stopAllSessions`)
- **Wiring:** `server/index.js` (shutdown handler)

## Dependencies

- **Browser-Use** — Session & profile management.
- **Distribution** — Process lifecycle.
