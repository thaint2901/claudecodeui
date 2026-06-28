# Capability: Multi-Provider Chat

## Description

Lets a user converse with any of the five supported AI coding CLIs (Claude, Cursor, Codex, Gemini, OpenCode) from a single chat composer. The user picks a provider, picks a model, picks a permission mode, and sends a message — the rest is provider-neutral from the UI's perspective.

## Actors

- **End-user developer** — Picks the provider, types the message.
- **The provider runtime** — Receives the message and streams back events.
- **The chat WebSocket hub** — Routes the message to the right runtime.
- **External integrators** — Use the same surface via `/api/agent`.

## Trigger

- The user types a message in `ChatComposer` and presses send (Enter or Ctrl+Enter).
- A `chat.send` envelope is emitted to the WebSocket.

## Flow

1. The user opens a session (or starts a new one) in a project.
2. The session is bound to a provider and a model (from the live model catalog).
3. The user types a message; the composer may include images, file mentions, and slash-command expansions.
4. The frontend sends a `chat.send` envelope with the session id, provider, model, permission mode, and the message payload.
5. The server-side WebSocket hub validates the user, looks up the session, and dispatches to the matching provider runtime.
6. The provider streams events back; the UI renders them as they arrive.
7. On the terminal `complete` event, the session settles and (optionally) fires a notification.

## Output

- A persistent session in the `sessions` table.
- Streamed events rendered in the chat pane.
- A terminal `complete` (or `error`) event.
- An optional web-push notification on completion.

## Technical Mapping

- **Frontend entry:** `src/components/chat/view/ChatInterface.tsx`, `subcomponents/ChatComposer.tsx`, `subcomponents/ChatMessagesPane.tsx`
- **Frontend context:** `src/contexts/WebSocketContext.tsx`
- **Backend dispatch:** `server/modules/websocket/services/chat-websocket.service.ts`
- **Provider runtimes:** `server/claude-sdk.js`, `server/cursor-cli.js`, `server/openai-codex.js`, `server/gemini-cli.js`, `server/opencode-cli.js`
- **Provider selection UI:** `src/components/llm-logo-provider/SessionProviderLogo.tsx`

## Dependencies

- **Provider Integration** — A registered provider with a working runtime.
- **Authentication & Security** — Authenticated WebSocket connection.
- **Session & Project Management** — A session to send the message into.
- **Notification System** — Fires on completion.
