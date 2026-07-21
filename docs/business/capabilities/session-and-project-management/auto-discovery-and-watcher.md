# Capability: Auto-Discovery & Watcher

## Description

Watches each provider's on-disk artifact root (jsonl files for Claude/Cursor/Codex; sqlite for OpenCode) and auto-inserts / updates the corresponding `sessions` rows. The watcher uses chokidar with a debounced `session_upserted` broadcast. A `scan_state` watermark tracks the last scan time to skip work.

## Actors

- **The sessions watcher service** — Watches the provider artifact roots.
- **The session synchronizer** — Per-provider disk rescan.
- **`scan_state` table** — Singleton watermark.
- **The chat run registry** — Receives `session_upserted` broadcasts.

## Trigger

- A provider writes a new jsonl file or sqlite row (filesystem event).
- A scheduled rescan runs.
- The host boots; an initial scan runs.

## Flow

1. On boot, the watcher service reads the `scan_state` watermark.
2. For each provider artifact root, the synchronizer scans for new / changed files.
3. For OpenCode / Cursor, the synchronizer opens the provider's DB in readonly mode and reads new sessions.
4. The watcher emits `session_upserted` broadcasts to the chat run registry.
5. The watermark is updated.

## Output

- A `sessions` table that mirrors the providers' on-disk state.
- Live broadcasts when sessions are created outside the UI.
- A scanner that doesn't redo work.

## Technical Mapping

- **Backend services:**
  - `server/modules/providers/services/sessions-watcher.service.ts`
  - `server/modules/providers/services/session-synchronizer.service.ts`
- **Backend repo:** `server/modules/database/repositories/scan-state.db.ts`
- **Library:** chokidar

## Dependencies

- **Database Layer** — `sessions` and `scan_state` tables.
- **Provider Integration** — Per-provider synchronizer.
