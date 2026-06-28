# Capability: Claude Runtime

## Description

Integrates Anthropic's official `@anthropic-ai/claude-agent-sdk` (no PTY) as the first-party provider. Powers the primary chat experience with native tool/permission approval, CLAUDE.md loading, structured event streaming, MCP server loading, and image attachments.

## Actors

- **End-user developer** — Chats with Claude.
- **`@anthropic-ai/claude-agent-sdk`** — The SDK the runtime calls.
- **The chat hub** — Routes events through the writer and registry.
- **MCP servers** — Loaded from `~/.claude.json`.

## Trigger

- The user picks Claude as the provider and sends a message.
- The user resumes a Claude session.

## Flow

1. The chat hub dispatches to `queryClaudeSDK` (`server/claude-sdk.js`).
2. The runtime opens a `query()` call with `cwd`, model, permission mode, allowed tools, MCP servers, and `sdkOptions.resume` (for resume).
3. The SDK streams events: text deltas, tool calls, permission requests, token usage, session id.
4. Events are normalized and emitted on the chat run registry.
5. On permission requests, the runtime calls `canUseTool` with the user's decision.
6. On terminal `complete`, the runtime fires `notifyRunStopped` / `notifyRunFailed`.

## Output

- A streaming Claude session.
- Permission requests surfaced to the user.
- Token usage updated live.
- Persisted in the Claude jsonl transcript.

## Technical Mapping

- **Server runtime:** `server/claude-sdk.js`
- **Provider class:** `server/modules/providers/list/claude/claude.provider.ts`
- **Provider facets:** `claude/auth.ts`, `claude/mcp.ts`, `claude/models.ts`, `claude/sessions.ts`, `claude/skills.ts`, `claude/session-synchronizer.ts`
- **MCP config:** `~/.claude.json` (read by `McpProvider` base)
- **Frontend logo:** `src/components/llm-logo-provider/ClaudeLogo.tsx`

## Dependencies

- **Provider Registry** — Registered in the registry.
- **Chat & Agent Streaming** — The hub that dispatches to this runtime.
- **MCP Integration** — Loads MCP servers from `~/.claude.json`.
- **Notification System** — `notifyRunStopped` / `notifyRunFailed`.
- **Authentication & Security** — User identity for permission decisions.
