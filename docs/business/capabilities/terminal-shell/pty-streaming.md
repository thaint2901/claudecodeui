# Capability: PTY Streaming

## Description

Provides a real pseudo-terminal (PTY) inside the app for each project, bound to the project's working directory. Keystrokes flow from the browser to the PTY; output flows from the PTY to the browser, complete with ANSI escape codes, all over WebSocket.

## Actors

- **End-user developer** — Types into the terminal.
- **xterm.js** — Renders the terminal output in the browser.
- **node-pty** — Spawns the shell on the server.
- **The shell WebSocket service** — Multiplexes stdin/stdout over WebSocket.

## Trigger

- The user opens the **Shell** tab for a project.

## Flow

1. `Shell.tsx` renders an xterm.js terminal.
2. The frontend opens a WebSocket to `/shell` (token-authenticated).
3. The server-side `shell-websocket.service.ts` spawns a `node-pty` process in the project cwd.
4. Browser keystrokes are sent as WebSocket messages → `node-pty` stdin.
5. `node-pty` stdout → WebSocket → xterm.js `write()`.
6. On disconnect, the PTY is closed; on reconnect, a fresh PTY is spawned.

## Output

- A live, in-browser terminal for the project's working directory.
- ANSI-colored output preserved.
- xterm.js keybindings (Ctrl+C, Ctrl+L, etc.) work natively.

## Technical Mapping

- **Frontend entry:** `src/components/shell/view/Shell.tsx`
- **Frontend renderer:** xterm.js
- **Backend service:** `server/modules/websocket/services/shell-websocket.service.ts`
- **Backend runtime:** `node-pty`

## Dependencies

- **Authentication & Security** — WebSocket token auth.
- **Session & Project Management** — The project cwd to spawn the PTY in.
- **Filesystem path validation** — `validateWorkspacePath` for the project path.
