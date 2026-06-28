# Capability: Gemini Runtime

## Description

Wraps the Gemini CLI (`gemini`) headlessly to provide Google's Gemini model family with image attachments, MCP discovery from `~/.gemini.json`, and exit-code-aware error messaging.

## Actors

- **End-user developer** — Chats with Gemini.
- **`gemini` CLI** — The PTY-spawned process.
- **The chat hub** — Routes events through the writer and registry.

## Trigger

- The user picks Gemini as the provider and sends a message.
- The user resumes a Gemini session with `--resume`.

## Flow

1. The chat hub dispatches to `spawnGemini` (`server/gemini-cli.js`).
2. The runtime spawns `gemini` via `sh -c exec` on POSIX (cross-spawn on Windows).
3. Auth env (`GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`) is loaded from `~/.gemini/.env` when missing.
4. MCP config is auto-loaded from `~/.gemini.json` when present (`--mcp-config`).
5. Flags: `--skip-trust`, `--yolo` / `--approval-mode` (auto_edit/plan), `--allowed-tools`.
6. Image attachments are saved to `cwd/.tmp/images` and the path is appended to the prompt.
7. Stream-JSON output is parsed by `GeminiResponseHandler` with NDJSON buffering.
8. Session init event captures `cliSessionId` for `--resume` on later turns.
9. Exit-code mapping: 41=auth, 42=invalid input, 44=sandbox, 52=config, 53=turn limit, 127=missing CLI.
10. Idle timeout: 120s with re-arm on stdout activity. Abort escalates SIGTERM → SIGKILL.
11. On terminal `complete`, `notifyRunStopped` / `notifyRunFailed` is called.

## Output

- A streaming Gemini session.
- Resumable session id.
- Persisted in the Gemini jsonl transcript.

## Technical Mapping

- **Server runtime:** `server/gemini-cli.js`
- **Provider class:** `server/modules/providers/list/gemini/gemini.provider.ts`
- **Provider facets:** `gemini/auth.ts`, `gemini/mcp.ts`, `gemini/models.ts`, `gemini/sessions.ts`, `gemini/skills.ts`, `gemini/session-synchronizer.ts`
- **MCP config:** `~/.gemini.json`
- **Legacy runtime:** `server/sessionManager.js` (in-memory + JSON, migration window)
- **Response handler:** `server/gemini-response-handler.js`
- **Frontend logo:** `src/components/llm-logo-provider/GeminiLogo.tsx`

## Dependencies

- **Provider Registry** — Registered in the registry.
- **Chat & Agent Streaming** — The hub that dispatches to this runtime.
- **MCP Integration** — Loads MCP servers from `~/.gemini.json`.
- **Notification System** — Lifecycle hook.
- **Authentication & Security** — User identity.
- **Database Layer** — Legacy `sessionManager.js` (whitelisted).
