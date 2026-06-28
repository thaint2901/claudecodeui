# Capability: Standalone Shell

## Description

A dedicated, full-window shell view that can be opened outside the normal project layout. Useful for power users, demos, and embedded scenarios where the project sidebar is in the way.

## Actors

- **End-user developer / demo viewer** — Opens the standalone shell.

## Trigger

- The user navigates to the standalone shell route (e.g. `/standalone-shell` or a deep link).
- A "pop out" button is clicked from the project shell.

## Flow

1. The user opens the standalone shell route.
2. `StandaloneShell.tsx` renders an xterm.js terminal that takes the full window.
3. The frontend opens a WebSocket to `/shell` with a project id (or no project, for a host shell).
4. The shell service spawns a PTY.
5. The user gets a full-screen terminal experience.

## Output

- A full-window, distraction-free terminal.
- The same auth URL and prompt picker affordances as the project shell.

## Technical Mapping

- **Frontend entry:** `src/components/standalone-shell/view/StandaloneShell.tsx`
- **Frontend subcomponents:** `subcomponents/StandaloneShellHeader.tsx`, `StandaloneShellEmptyState.tsx`
- **Backend service:** `server/modules/websocket/services/shell-websocket.service.ts` (shared with project shell)

## Dependencies

- **Terminal/Shell** — The underlying PTY streaming capability.
- **Authentication & Security** — WebSocket token auth.
