# Subsystem 1: Chat & Agent Streaming

## Business Purpose

The **Chat & Agent Streaming** subsystem is the primary workspace of CloudCLI UI. It gives developers a streaming, session-based chat interface to converse with five different AI coding CLIs in one place — with persistent message history, live tool-call rendering, permission approvals, voice input, image attachments, slash commands, and token-usage tracking.

It is the single feature that every other subsystem exists to support: providers stream into it, sessions are managed by it, permissions gate it, and notifications fire when a run in it finishes.

## Key Capabilities

| Capability | Description |
|------------|-------------|
| **Multi-provider chat** | Send messages to Claude, Cursor, Codex, Gemini, or OpenCode from a single composer. |
| **Streaming events** | Receive token-by-token text, tool calls, reasoning blocks, and usage in real time. |
| **Tool call rendering** | Display file reads, edits, bash, web searches, sub-agents, plans, and AskUserQuestion prompts. |
| **Permission approvals** | Approve or deny tool calls inline; persist "remember this choice" rules. |
| **Permission modes** | Cycle through default / accept-edits / plan / bypass-permissions per session. |
| **Model selection** | Pick from the live per-provider model catalog. |
| **Session resume** | Reopen past sessions with full history and continue from where the user left off. |
| **Image attachments** | Attach images to messages (saved to `.tmp/images` in the project cwd). |
| **Voice input** | Use speech-to-text to compose messages via the Voice Proxy. |
| **Slash commands** | Invoke user-defined markdown commands and built-ins like `/models`. |
| **File autocomplete** | Mention files in the composer with autocomplete from the file tree. |
| **Token-usage tracking** | See per-session token spend and context-window utilization. |
| **Abort & control** | Abort a running session, auto-scroll, expand tools, raw parameters, Ctrl+Enter send. |
| **Message actions** | Copy any message, text-to-speech any message. |
| **Session lock (background agent)** | Detect and disable the composer when a session is held by a Claude Code background/daemon worker; Stop & Resume to reclaim it. |

## Stakeholders

| Stakeholder | What They Get |
|-------------|---------------|
| **End-user developers** | A single chat surface for every CLI agent they use. |
| **Power users** | Multi-session, multi-project chat with full history and search. |
| **External integrators** | Programmatic access to the same chat surface via `/api/agent`. |
| **The LLM agent itself** | A standard tool-approval surface (the PermissionContext) and a stable session id to resume. |
| **Notification consumers** | Run lifecycle events (stopped, failed, action-required) that fire web-push. |

## How It Works (End-to-End)

1. The user types a message in `ChatInterface` (`src/components/chat/view/ChatInterface.tsx`).
2. The frontend opens a WebSocket to `/ws` via `WebSocketContext` (token-authenticated).
3. The frontend sends a `chat.send` envelope with the session id, provider, model, permission mode, and the message payload.
4. The server-side WebSocket hub (`server/modules/websocket/services/chat-websocket.service.ts`) validates the user, looks up the session, and dispatches to the provider's spawn function (`queryClaudeSDK`, `spawnCursor`, `queryCodex`, `spawnGemini`, `spawnOpenCode`).
5. The provider streams events: assistant text deltas, tool calls, permission requests, session id announcements, token usage, and a final terminal `complete` event.
6. The `ChatSessionWriter` assigns sequence numbers and remaps the provider-native session id to a stable app-facing id.
7. The hub broadcasts each event to all connected clients subscribed to that session.
8. `ChatMessagesPane` renders the events as they arrive; `ToolRenderer` dispatches to the right tool sub-renderer.
9. When a tool call requires approval, the `PermissionRequestsBanner` surfaces it; the user's decision is sent back as a `chat.permission-response`.
10. On the terminal `complete` event, the session is marked completed, `notifyRunStopped` / `notifyRunFailed` may fire, and the UI settles.

## Cross-Cutting Concerns

- **Session-id identity mapping** — The `session_id` is the stable app-facing id; `provider_session_id` is the native CLI/SDK id. The `chat-session-writer.service.ts` remaps during streaming so the UI never sees two different ids for the same session.
- **Sequence numbers** — Every event gets a `seq` number from `chat-session-writer` so reconnecting clients can resume without gaps.
- **Event replay buffer** — `chat-run-registry` buffers recent events so a page refresh mid-stream can `attach-connection` and replay the tail.
- **Tool permission model** — Handled by `src/contexts/PermissionContext.tsx`; the server-side counterpart is in `claude-sdk.js` (`canUseTool` for Claude) and the provider capability matrix.
- **Token usage** — Extracted per-provider (Claude `message.usage` / `modelUsage`, Codex `turn.completed.usage`, OpenCode SQLite). Surfaced in `TokenUsageSummary` and the context-window meter.
- **Notification** — `notifyRunStopped` / `notifyRunFailed` are called from the chat run lifecycle; the orchestrator handles the rest.

## Technical Mapping (Entry Points)

- **Frontend entry:** `src/components/chat/view/ChatInterface.tsx`
- **Frontend context:** `src/contexts/WebSocketContext.tsx`, `src/contexts/PermissionContext.tsx`
- **Backend entry:** `server/modules/websocket/services/chat-websocket.service.ts`
- **Backend dispatch:** `server/modules/websocket/services/chat-run-registry.service.ts`, `chat-session-writer.service.ts`
- **Provider runtimes:** `server/claude-sdk.js`, `server/cursor-cli.js`, `server/openai-codex.js`, `server/gemini-cli.js`, `server/opencode-cli.js`
- **Provider services:** `server/modules/providers/services/sessions.service.ts`, `provider-models.service.ts`, `provider-capabilities.service.ts`

## Capability Documents

- [capabilities/chat-and-agent-streaming/multi-provider-chat.md](capabilities/chat-and-agent-streaming/multi-provider-chat.md)
- [capabilities/chat-and-agent-streaming/streaming-and-event-replay.md](capabilities/chat-and-agent-streaming/streaming-and-event-replay.md)
- [capabilities/chat-and-agent-streaming/tool-call-rendering.md](capabilities/chat-and-agent-streaming/tool-call-rendering.md)
- [capabilities/chat-and-agent-streaming/permission-and-tool-approval.md](capabilities/chat-and-agent-streaming/permission-and-tool-approval.md)
- [capabilities/chat-and-agent-streaming/session-resume-and-history.md](capabilities/chat-and-agent-streaming/session-resume-and-history.md)
- [capabilities/chat-and-agent-streaming/voice-and-image-input.md](capabilities/chat-and-agent-streaming/voice-and-image-input.md)
- [capabilities/chat-and-agent-streaming/slash-commands.md](capabilities/chat-and-agent-streaming/slash-commands.md)
- [capabilities/chat-and-agent-streaming/token-usage-and-context-window.md](capabilities/chat-and-agent-streaming/token-usage-and-context-window.md)
- [capabilities/chat-and-agent-streaming/session-lock.md](capabilities/chat-and-agent-streaming/session-lock.md)
