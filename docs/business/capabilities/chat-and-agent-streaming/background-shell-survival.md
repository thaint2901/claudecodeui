# Background Shell Survival

## Description
Long-running shell commands started by the agent keep running after the chat turn
that launched them ends, and report their real outcome when they finish.

## Actors
The user who asked for the long command; the Claude runtime that backgrounds it.

## Trigger
A `Bash` tool call either sets `run_in_background: true`, or exceeds its timeout
(120s by default) and is auto-backgrounded by the Claude CLI.

## Flow
1. The runtime backgrounds the command and returns a task id plus an output file path.
2. The turn completes normally; the UI stops showing "processing".
3. ccui keeps the session's CLI process alive because a tracked task is still live.
4. The command finishes, or is killed by the OS memory-pressure reaper.
5. ccui emits a session-scoped `background_task` event; the user is notified.
6. With no tasks left, ccui closes the process after a 60s idle grace period.

## Output
A notification carrying the task's terminal status (`completed`, `failed`, or
`stopped`), its summary, and the path to its full output file.

## Technical Mapping
- `server/claude-session-input-stream.js` — the input stream whose open state keeps the CLI from reaping tasks
- `server/claude-session-pool.js` — process lifetime, turn demux, live-task tracking
- `server/claude-sdk.js` — SDK message translation; drives the pool per turn
- `server/modules/websocket/services/chat-session-events.service.ts` — the `background_task` frame
- `src/components/chat/hooks/useChatRealtimeHandlers.ts` — surfaces it without touching the transcript store

## Dependencies
Claude provider only. Requires `@anthropic-ai/claude-agent-sdk` streaming input
mode; the CLI reaps background tasks whenever its input is closed.
