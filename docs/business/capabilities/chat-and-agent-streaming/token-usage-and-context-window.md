# Capability: Token Usage & Context Window

## Description

Tracks per-session token spend and context-window utilization across all providers. The user sees a real-time meter in the chat composer and a detailed summary in the messages pane. Token usage is extracted provider-aware: Claude `message.usage` / `modelUsage`, Codex `turn.completed.usage`, OpenCode SQLite session table.

## Actors

- **End-user developer** — Watches the meter to know how much context is left.
- **The provider runtime** — Emits usage data.
- **The token-usage endpoint** — Backfills from transcripts for past sessions.
- **The TokenUsageSummary** — Renders the breakdown in the UI.

## Trigger

- A provider emits a usage event in the stream (live).
- The user opens a past session and the endpoint backfills usage from the transcript.

## Flow (Live)

1. The provider runtime emits a usage event.
2. The chat run registry stores the latest usage for the session.
3. The composer meter updates on the next render.
4. `TokenUsageSummary` shows the full breakdown (input, output, cache, reasoning).

## Flow (Backfill)

1. The user opens a past session.
2. The frontend calls `GET /api/sessions/:id/token-usage`.
3. The endpoint parses the provider transcript:
   - Claude/Codex/Cursor: jsonl
   - OpenCode: `~/.local/share/opencode/opencode.db`
4. The latest usage is returned and rendered.

## Output

- A live token-usage meter in the composer.
- A detailed breakdown in the messages pane.
- Historical usage for past sessions.
- (Optionally) the model's context-window limit, used to compute remaining percentage.

## Technical Mapping

- **Frontend UI:** `src/components/chat/view/subcomponents/TokenUsageSummary.tsx`
- **Backend live extraction:**
  - Claude: `message.usage` / `modelUsage` in `server/claude-sdk.js`
  - Codex: `turn.completed.usage` in `server/openai-codex.js`
  - OpenCode: sqlite session table in `server/opencode-cli.js`
- **Backend backfill:** `/api/sessions/:id/token-usage` in `server/index.js` (parses jsonl / sqlite)
- **Models service:** `server/modules/providers/services/provider-models.service.ts` (context window)

## Dependencies

- **Chat & Agent Streaming** — The live event stream.
- **Provider Integration** — Per-provider usage extraction.
- **Session & Project Management** — The session row and transcript path.
