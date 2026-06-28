# Capability: Codex Runtime

## Description

Integrates OpenAI Codex using the `@openai/codex-sdk` for non-interactive coding sessions. Maps the in-app permission modes to `sandboxMode` + `approvalPolicy`, normalizes streaming turn events, and runs a reaper for stale completed sessions.

## Actors

- **End-user developer** — Chats with Codex.
- **`@openai/codex-sdk`** — The SDK the runtime calls.
- **The chat hub** — Routes events through the writer and registry.
- **The session reaper** — Cleans up completed sessions after 30 min.

## Trigger

- The user picks Codex as the provider and sends a message.
- The user resumes a Codex thread.

## Flow

1. The chat hub dispatches to `queryCodex` (`server/openai-codex.js`).
2. The runtime starts (or resumes) a Codex thread with `skipGitRepoCheck`.
3. Permission modes map to `sandboxMode` + `approvalPolicy`:
   - default → workspace-write
   - bypassPermissions → danger-full-access
4. The SDK streams turn events: `item.started/updated/completed` (agent_message, reasoning, command_execution, file_change, mcp_tool_call, web_search, todo_list, error).
5. Events are normalized and emitted on the chat run registry.
6. `turn.completed.usage` is read for token usage.
7. On abort, `AbortController` is signaled; the status flag prevents double terminal complete.
8. The reaper drops completed sessions after 30 min.
9. On terminal `complete`, `notifyRunStopped` / `notifyRunFailed` is called.

## Output

- A streaming Codex session.
- Token usage updated on each turn.
- Persisted in the Codex jsonl transcript.

## Technical Mapping

- **Server runtime:** `server/openai-codex.js`
- **Provider class:** `server/modules/providers/list/codex/codex.provider.ts`
- **Provider facets:** `codex/auth.ts`, `codex/mcp.ts`, `codex/models.ts`, `codex/sessions.ts`, `codex/skills.ts`, `codex/session-synchronizer.ts`
- **MCP config:** `~/.codex/config.toml`
- **Frontend logo:** `src/components/llm-logo-provider/CodexLogo.tsx`

## Dependencies

- **Provider Registry** — Registered in the registry.
- **Chat & Agent Streaming** — The hub that dispatches to this runtime.
- **MCP Integration** — Loads MCP servers from `~/.codex/config.toml`.
- **Notification System** — Lifecycle hook.
- **Authentication & Security** — User identity.
