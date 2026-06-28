# Subsystem 2: Terminal/Shell

## Business Purpose

The **Terminal/Shell** subsystem gives every project its own **PTY-backed terminal** inside the app. It streams the same way the chat does — over WebSocket — so users can run CLI commands, watch agent processes, copy authentication URLs, and pick from CLI prompt options without ever leaving the browser.

It also provides a **standalone shell page** that can be opened outside the normal project layout, useful for power users, demos, and embedded scenarios.

## Key Capabilities

| Capability | Description |
|------------|-------------|
| **Per-project PTY** | Spawn a real pseudo-terminal (node-pty) bound to the project's working directory. |
| **ANSI streaming** | Stream the terminal's raw output (including ANSI escape codes) over WebSocket. |
| **Connect / disconnect** | Open and close the PTY connection on demand; restart on demand. |
| **Auth URL detection** | Detect `http(s)://` URLs in the buffer and surface a one-click "open in browser" affordance. |
| **CLI prompt pickers** | Detect interactive prompt options (Claude login, Gemini, etc.) and let the user click to choose. |
| **Terminal keyboard shortcuts** | Display a help panel for the most useful xterm.js keybindings. |
| **Resume support** | Reconnect to an existing PTY session on page refresh. |
| **Standalone shell** | A dedicated, full-window shell view decoupled from the project sidebar. |
| **xterm.js rendering** | Full xterm.js terminal emulator in the browser for an authentic terminal experience. |

## Stakeholders

| Stakeholder | What They Get |
|-------------|---------------|
| **End-user developers** | A real terminal in the browser for the same project the agent is working in. |
| **Provider login flows** | A way to complete the Claude / Cursor / Gemini / OpenCode login without leaving the app. |
| **Power users** | A full-screen standalone shell for demos and embedded use. |
| **Agent processes** | The user can watch long-running agent processes and interact with prompts. |

## How It Works (End-to-End)

1. The user opens the **Shell** tab for a project in `MainContent` (`src/components/main-content/view/`).
2. `Shell.tsx` (`src/components/shell/view/Shell.tsx`) renders an xterm.js terminal.
3. The frontend opens a WebSocket to `/shell` (token-authenticated).
4. The server-side `shell-websocket.service.ts` (`server/modules/websocket/services/`) spawns a `node-pty` process using the project cwd and the configured provider command (or a default shell).
5. PTY data flows: browser keystrokes → WebSocket → `node-pty` stdin; `node-pty` stdout → WebSocket → xterm.js write.
6. `url-detection.js` parses the buffer for auth URLs; detected URLs surface as clickable buttons.
7. Prompt-picker detection scans the buffer for known interactive prompts; matches become clickable options.
8. On disconnect, the PTY is closed; on reconnect, a fresh PTY is spawned (no persistence beyond the session).

## Cross-Cutting Concerns

- **Authentication** — Uses the same JWT verification as the chat WebSocket (`/ws`), applied during the upgrade handshake.
- **Heartbeat** — 30-second pings survive reverse-proxy idle timeouts (shared with the chat hub).
- **Env hardening** — Inherits the same `WS_OPEN_STATE` and `connectedClients` set used by the chat hub for cross-service broadcasts.
- **ANSI stripping** — Used by the log capture side of the system (`server/utils/url-detection.js`, `colors.js`).
- **Per-project cwd** — The PTY's working directory is the project's normalized `project_path` (`validateWorkspacePath` in `server/shared/utils.ts`).

## Technical Mapping (Entry Points)

- **Frontend entry (project shell):** `src/components/shell/view/Shell.tsx`
- **Frontend entry (standalone shell):** `src/components/standalone-shell/view/StandaloneShell.tsx`
- **Frontend subcomponents:** `src/components/shell/view/subcomponents/` (header, empty state, connection overlay, minimal view, shortcuts panel)
- **Backend service:** `server/modules/websocket/services/shell-websocket.service.ts`
- **Backend helpers:** `server/utils/url-detection.js` (auth URL + prompt picker detection), `server/utils/colors.js` (ANSI stripping)
- **Dependency:** `node-pty`, `xterm.js`, `ws`

## Capability Documents

- [capabilities/terminal-shell/pty-streaming.md](capabilities/terminal-shell/pty-streaming.md)
- [capabilities/terminal-shell/auth-url-and-prompt-pickers.md](capabilities/terminal-shell/auth-url-and-prompt-pickers.md)
- [capabilities/terminal-shell/standalone-shell.md](capabilities/terminal-shell/standalone-shell.md)
- [capabilities/terminal-shell/connection-lifecycle.md](capabilities/terminal-shell/connection-lifecycle.md)
