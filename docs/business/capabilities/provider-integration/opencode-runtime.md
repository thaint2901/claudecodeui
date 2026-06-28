# Capability: OpenCode Runtime

## Description

Integrates the OpenCode CLI (`opencode run`) for an additional coding agent. Reads session token usage directly from the OpenCode SQLite DB to back the UI's context window meter. Forces `--dir` to the actual project cwd to avoid server install-dir resolution issues on Linux.

## Actors

- **End-user developer** — Chats with OpenCode.
- **`opencode` CLI** — The PTY-spawned process.
- **The OpenCode SQLite DB** — Read post-run for token usage.
- **The chat hub** — Routes events through the writer and registry.

## Trigger

- The user picks OpenCode as the provider and sends a message.
- The user resumes an OpenCode session with `--session`.

## Flow

1. The chat hub dispatches to `spawnOpenCode` (`server/opencode-cli.js`).
2. The runtime spawns `opencode run --format json --dir <cwd> [--session <id>] [--model <id>] <prompt>`.
3. Stream-JSON lines are parsed with partial-line buffering.
4. Session id is auto-captured from `event.sessionID` / `sessionId`.
5. On abort, SIGTERM is sent and the `aborted` flag prevents double terminal complete.
6. Post-run, the runtime opens the OpenCode SQLite DB readonly and reads the session's token usage (input/output/reasoning/cache read+write).
7. On terminal `complete`, `notifyRunStopped` / `notifyRunFailed` is called.

## Output

- A streaming OpenCode session.
- Resumable session id.
- Token usage pulled directly from the OpenCode DB.

## Technical Mapping

- **Server runtime:** `server/opencode-cli.js`
- **Provider class:** `server/modules/providers/list/opencode/opencode.provider.ts`
- **Provider facets:** `opencode/auth.ts`, `opencode/mcp.ts`, `opencode/models.ts`, `opencode/sessions.ts`, `opencode/skills.ts`, `opencode/session-synchronizer.ts`
- **MCP config:** `opencode.json`
- **Token usage source:** `~/.local/share/opencode/opencode.db` (read-only better-sqlite3)
- **Frontend logo:** `src/components/llm-logo-provider/OpenCodeLogo.tsx`

## Dependencies

- **Provider Registry** — Registered in the registry.
- **Chat & Agent Streaming** — The hub that dispatches to this runtime.
- **MCP Integration** — Loads MCP servers from `opencode.json`.
- **Notification System** — Lifecycle hook.
- **Authentication & Security** — User identity.
- **Session & Project Management** — Synchronizer reads the OpenCode DB.
