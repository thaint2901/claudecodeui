# Capability: Token Usage Lookup

## Description

Parses the provider transcript (jsonl for Claude/Codex/Gemini/Cursor; sqlite for OpenCode) to extract per-session token usage. Backfills the live usage meter when the user opens a past session.

## Actors

- **End user** — Opens a past session and wants to see the token spend.
- **The token-usage endpoint** — Parses the transcript.
- **The provider transcript** — On disk.

## Trigger

- The user opens a past session.

## Flow

1. The chat view mounts for a past session.
2. The frontend calls `GET /api/sessions/:id/token-usage`.
3. The endpoint resolves the `jsonl_path` (or OpenCode DB path) from the `sessions` row.
4. The transcript is parsed provider-aware.
5. The latest usage is returned and rendered in `TokenUsageSummary`.

## Output

- A per-session token usage breakdown.
- The context-window meter is updated.
- Historical data is available for the session.

## Technical Mapping

- **Backend endpoint:** `server/index.js` (`/api/sessions/:id/token-usage`)
- **Backend providers:**
  - Claude/Codex/Gemini/Cursor: jsonl parser
  - OpenCode: sqlite reader (`getOpenCodeDatabasePath`)

## Dependencies

- **Session & Project Management** — Session row and transcript path.
- **Provider Integration** — Per-provider transcript format.
