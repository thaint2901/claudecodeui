# Capability: Cursor Runtime

## Description

Wraps the Cursor CLI (`cursor-agent`) for Cursor's agent mode, streamed over WebSocket with workspace-trust auto-retry, model override, and skip-permissions support.

## Actors

- **End-user developer** — Chats with Cursor.
- **`cursor-agent` CLI** — The PTY-spawned process.
- **The chat hub** — Routes events through the writer and registry.

## Trigger

- The user picks Cursor as the provider and sends a message.
- The user resumes a Cursor session with `--resume`.

## Flow

1. The chat hub dispatches to `spawnCursor` (`server/cursor-cli.js`).
2. The runtime spawns `cursor-agent` with `--resume`, `--model`, `--output-format stream-json`, `-p`, and (if enabled) `-f` for skip-permissions.
3. On Windows, uses `cross-spawn` for compatibility.
4. stdout is parsed as stream-JSON with partial-line buffering across chunks.
5. If a workspace-trust prompt is detected, the runtime retries with `--trust`.
6. Session id is captured from the `system/init` event; `session_created` is emitted exactly once.
7. On abort, SIGTERM is sent and the `aborted` flag prevents double terminal complete.
8. On terminal `complete`, `notifyRunStopped` / `notifyRunFailed` is called.

## Output

- A streaming Cursor session.
- Session id captured once.
- Persisted in the Cursor store.db transcript.

## Technical Mapping

- **Server runtime:** `server/cursor-cli.js`
- **Provider class:** `server/modules/providers/list/cursor/cursor.provider.ts`
- **Provider facets:** `cursor/auth.ts`, `cursor/mcp.ts`, `cursor/models.ts`, `cursor/sessions.ts`, `cursor/skills.ts`, `cursor/session-synchronizer.ts`
- **MCP config:** `~/.cursor/mcp.json`
- **Transcript location:** `~/.cursor/chats/{workspace}/{sessionId}/store.db` (per-session)
- **Frontend logo:** `src/components/llm-logo-provider/CursorLogo.tsx`

## Dependencies

- **Provider Registry** — Registered in the registry.
- **Chat & Agent Streaming** — The hub that dispatches to this runtime.
- **MCP Integration** — Loads MCP servers from `~/.cursor/mcp.json`.
- **Notification System** — Lifecycle hook.
- **Authentication & Security** — User identity.
