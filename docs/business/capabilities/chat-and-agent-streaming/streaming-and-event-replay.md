# Capability: Streaming & Event Replay

## Description

Streams provider events (assistant text deltas, tool calls, reasoning, token usage, permission requests) to the user in real time. Maintains a per-session event buffer and sequence numbers so a page refresh mid-stream can reattach and replay the tail without losing events.

## Actors

- **End-user developer** — Sees tokens appear as the agent thinks.
- **The provider runtime** — Emits events in real time.
- **The chat run registry** — Buffers events and serves replays.
- **The chat session writer** — Assigns sequence numbers and remaps session ids.

## Trigger

- A `chat.send` envelope is processed; the provider runtime starts emitting events.
- A reattaching client sends `chat.subscribe` with the session id.

## Flow (Streaming)

1. The provider runtime emits a stream of normalized events.
2. The `ChatSessionWriter` assigns a monotonic `seq` number to each event.
3. The writer remaps the provider-native session id to the stable app id.
4. The hub broadcasts the event to all connected clients subscribed to that session.
5. The `ChatMessagesPane` appends the event to the in-memory message list and re-renders.

## Flow (Replay on Reconnect)

1. The user refreshes the page mid-run; the chat view remounts.
2. The frontend sends `chat.subscribe` with the session id.
3. The `ChatRunRegistry` looks up the live run for the session.
4. The registry replays buffered events in order to the new connection.
5. The UI catches up to the live tail and continues receiving new events.

## Output

- A live, gap-free stream of events for every connected client.
- A consistent, deterministic event order via sequence numbers.
- A stable app-facing session id that doesn't change as the provider re-identifies itself.

## Technical Mapping

- **Frontend consumer:** `src/components/chat/view/subcomponents/ChatMessagesPane.tsx`, `MessageComponent.tsx`
- **Backend writer:** `server/modules/websocket/services/chat-session-writer.service.ts`
- **Backend registry:** `server/modules/websocket/services/chat-run-registry.service.ts`
- **Backend service:** `server/modules/websocket/services/chat-websocket.service.ts`
- **Protocol:** `server/shared/utils.ts` (`createCompleteMessage`, `createNormalizedMessage`)

## Dependencies

- **Provider Integration** — The runtime must emit events.
- **Authentication & Security** — Authenticated WebSocket.
- **Session & Project Management** — A session id to subscribe to.
