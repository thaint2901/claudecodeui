# Subsystem 3: Provider Integration

## Business Purpose

The **Provider Integration** subsystem is the single source of truth for which AI coding CLIs CloudCLI UI supports. It defines a uniform interface (`IProvider` with auth, mcp, models, skills, sessions, and session-synchronizer facets), wires concrete implementations for each supported CLI, and exposes a capability matrix so the UI can adapt to provider differences.

Adding a new provider means implementing one abstract base class and registering it in the provider registry — the chat, sidebar, file tree, and Agent API all pick it up automatically.

## Supported Providers

| Provider | Integration | Runtime | Server File |
|----------|-------------|---------|-------------|
| **Claude** (`claude`) | SDK | `@anthropic-ai/claude-agent-sdk` (no PTY) | `server/claude-sdk.js` |
| **Cursor** (`cursor`) | PTY | `cursor-agent` CLI | `server/cursor-cli.js` |
| **Codex** (`codex`) | SDK | `@openai/codex-sdk` | `server/openai-codex.js` |
| **Gemini** (`gemini`) | PTY | `gemini` CLI | `server/gemini-cli.js` |
| **OpenCode** (`opencode`) | PTY | `opencode run` CLI | `server/opencode-cli.js` |

## Key Capabilities

| Capability | Description |
|------------|-------------|
| **Provider registry** | `listProviders()` / `resolveProvider()` — single source of truth. Unsupported providers return 400. |
| **Abstract provider** | `AbstractProvider` base class implementing `IProvider` (auth, mcp, models, skills, sessions, sessionSynchronizer). |
| **Provider runtimes** | Top-level spawn functions wired into the WS hub: `queryClaudeSDK`, `spawnCursor`, `queryCodex`, `spawnGemini`, `spawnOpenCode` (and matching abort functions). |
| **MCP per provider** | `McpProvider` base handles per-scope config file read/write for stdio / http / sse MCP servers. |
| **Skills per provider** | `SkillsProvider` base handles `SKILL.md` discovery and per-scope configuration. |
| **Capability matrix** | Exposes permission modes, image support, abort support, and token-usage support to the frontend. |
| **Auth flow** | Per-provider auth status and login flow (browser-based, device-code, env var). |
| **Model catalog** | `getProviderModels` reads from the live provider API with a 3-day on-disk cache. |
| **Session resume** | Provider-aware `--resume` / SDK resume that maps back to the stable app session id. |
| **Session synchronizer** | Per-provider disk rescan that ingests transcripts into the `sessions` table. |
| **Token usage** | Provider-aware extraction (Claude `message.usage`, Codex `turn.completed.usage`, OpenCode SQLite). |
| **Notification hooks** | `notifyRunStopped` / `notifyRunFailed` are called from the provider runtime after a run completes or errors. |

## Per-Provider Highlights

### Claude

- Official `@anthropic-ai/claude-agent-sdk` (no PTY).
- Streaming JSON event normalization into WebSocket messages.
- Interactive tool approval (`canUseTool`) for `AskUserQuestion` and `ExitPlanMode`.
- Permission-mode mapping (default / plan / acceptEdits / bypassPermissions) plus allowed/disallowed tool rules.
- Session resume via `sdkOptions.resume`; session id captured from stream.
- Image attachments saved to `cwd/.tmp/images`.
- MCP servers loaded from `~/.claude.json` (global + per-project).
- Token budget extraction from `message.usage` / `modelUsage`.
- Abort via `query.interrupt()` with single terminal `complete` contract.
- Hook-based notification to user push notifications.

### Cursor

- Spawns `cursor-agent` (cross-spawn on Windows) with `--resume`, `--model`, `--output-format stream-json`, `-p`.
- Stream-JSON parsing with partial-line buffering across stdout chunks.
- Workspace-trust prompt detection plus automatic `--trust` retry.
- Skip-permissions via `-f` flag.
- Session id capture from `system/init` event; emits `session_created` exactly once.
- Abort via SIGTERM with `aborted` flag to prevent double terminal complete.
- Notification lifecycle hook (stopped vs failed) with `sessionName` metadata.

### Codex

- Codex SDK thread start/resume with `skipGitRepoCheck`.
- Permission-mode mapping to `sandboxMode` + `approvalPolicy` (workspace-write / danger-full-access).
- Streaming turn events with `item.started/updated/completed` normalization (agent_message, reasoning, command_execution, file_change, mcp_tool_call, web_search, todo_list, error).
- Thread/turn lifecycle handling (thread.started then turn.completed / turn.failed).
- Token budget extraction from `turn.completed.usage`.
- AbortController-based abort with status flag coordination.
- Cross-writer WebSocket send (SSEStreamWriter / WebSocketWriter / raw ws).
- Reaper for stale completed sessions (30 min TTL).

### Gemini

- Spawns `gemini` via `sh -c exec` on POSIX (cross-spawn on Windows).
- Stream-JSON output parsed by `GeminiResponseHandler` with NDJSON buffering.
- Image attachments (saves base64 to `cwd/.tmp/images`, appends path note to prompt).
- Loads auth env (`GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`) from `~/.gemini/.env` when process env is missing.
- MCP config auto-loaded from `~/.gemini.json` when present (`--mcp-config`).
- Flags: `--skip-trust`, `--yolo` / `--approval-mode` (auto_edit/plan), `--allowed-tools`.
- Session init event captures `cliSessionId` for `--resume` on later turns.
- Exit-code mapping (41=auth, 42=invalid input, 44=sandbox, 52=config, 53=turn limit, 127=missing CLI).
- Idle timeout (120s) with re-arm on stdout activity; SIGTERM then SIGKILL escalation on abort.

### OpenCode

- Spawns `opencode run --format json --dir <cwd> [--session <id>] [--model <id>] <prompt>`.
- Forces `--dir` to the actual project cwd (avoids server install-dir resolution on Linux).
- Stream-JSON line parser with partial-line buffering.
- Session id auto-capture from `event.sessionID` / `sessionId`.
- Token usage read post-run from OpenCode SQLite session table (input/output/reasoning/cache read+write).
- SIGTERM abort with single terminal complete contract.
- Resolution of run dir via better-sqlite3 readonly handle with column-schema check.

## Stakeholders

| Stakeholder | What They Get |
|-------------|---------------|
| **End users** | One chat surface that works the same for every supported provider. |
| **Plugin authors** | A stable `IProvider` interface to integrate new tools. |
| **External integrators** | A consistent `/api/agent` surface that accepts any provider. |
| **The app itself** | A single registry to iterate and a capability matrix to adapt the UI. |

## Cross-Cutting Concerns

- **Capability matrix** — `provider-capabilities.service.ts` returns what each provider supports (permission modes, image support, abort, token usage) so the UI can hide/show controls.
- **Session-id remapping** — The `ChatSessionWriter` remaps the provider-native id to the stable app id; the `sessions` table stores both.
- **Notification hooks** — All provider runtimes call `notifyRunStopped` / `notifyRunFailed` on terminal events.
- **Auth & credentials** — Per-provider credentials are stored in `user_credentials` (polymorphic by `credential_type`).
- **MCP per provider** — Each provider has its own config file format; `McpProvider` base adapts.

## Technical Mapping (Entry Points)

- **Registry:** `server/modules/providers/provider.registry.ts`
- **Abstract base:** `server/modules/providers/shared/base/abstract.provider.ts`
- **MCP base:** `server/modules/providers/shared/mcp/mcp.provider.ts`
- **Skills base:** `server/modules/providers/shared/skills/skills.provider.ts`
- **Claude:** `server/modules/providers/list/claude/` + `server/claude-sdk.js`
- **Cursor:** `server/modules/providers/list/cursor/` + `server/cursor-cli.js`
- **Codex:** `server/modules/providers/list/codex/` + `server/openai-codex.js`
- **Gemini:** `server/modules/providers/list/gemini/` + `server/gemini-cli.js`
- **OpenCode:** `server/modules/providers/list/opencode/` + `server/opencode-cli.js`
- **Application services:** `server/modules/providers/services/` (sessions, models, mcp, skills, auth, capabilities, synchronizer, watcher, search)
- **REST:** `server/modules/providers/provider.routes.ts`
- **Frontend:** `src/components/llm-logo-provider/` (logo + provider switcher)

## Capability Documents

- [capabilities/provider-integration/provider-registry.md](capabilities/provider-integration/provider-registry.md)
- [capabilities/provider-integration/claude-runtime.md](capabilities/provider-integration/claude-runtime.md)
- [capabilities/provider-integration/cursor-runtime.md](capabilities/provider-integration/cursor-runtime.md)
- [capabilities/provider-integration/codex-runtime.md](capabilities/provider-integration/codex-runtime.md)
- [capabilities/provider-integration/gemini-runtime.md](capabilities/provider-integration/gemini-runtime.md)
- [capabilities/provider-integration/opencode-runtime.md](capabilities/provider-integration/opencode-runtime.md)
- [capabilities/provider-integration/model-catalog.md](capabilities/provider-integration/model-catalog.md)
- [capabilities/provider-integration/capability-matrix.md](capabilities/provider-integration/capability-matrix.md)
- [capabilities/provider-integration/provider-auth.md](capabilities/provider-integration/provider-auth.md)
