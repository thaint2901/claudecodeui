# Capability: Schema & Migrations

## Description

Defines the full SQLite schema (`INIT_SCHEMA_SQL`) and runs idempotent migrations on every boot. Migrations add new columns, rebuild legacy tables into the current shape, and drop obsolete ones. Safe to re-run after interrupted boots.

## Actors

- **The host server** — Triggers schema and migrations on boot.
- **`INIT_SCHEMA_SQL`** — The full schema.
- **`migrations.ts`** — Idempotent migration runner.

## Trigger

- The server boots (after connection open).

## Flow

1. `connection.ts` opens the SQLite handle.
2. `init-db.ts` applies `INIT_SCHEMA_SQL` (creates all tables if missing).
3. `migrations.ts` runs idempotent migrations:
   - Adds the `provider_session_id` column to `sessions` if missing.
   - Rebuilds `workspace_original_paths` into `projects` (with new PK + display name resolution).
   - Merges `session_names` into `sessions` (preserving custom name and timestamps).
   - Drops legacy tables when empty.
4. The schema is now current.

## Output

- A current, consistent schema.
- No legacy tables or columns.
- A migration log on every boot (idempotent).

## Technical Mapping

- **Schema:** `server/modules/database/schema.ts`
- **Migrations:** `server/modules/database/migrations.ts`
- **Init:** `server/modules/database/init-db.ts`

## Dependencies

- **Database Layer** — Connection & bootstrap.
