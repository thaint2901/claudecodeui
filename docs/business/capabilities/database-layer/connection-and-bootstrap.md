# Capability: Connection & Bootstrap

## Description

Owns the single better-sqlite3 connection that backs the entire app. Resolves the database path from env / CLI / default, creates the directory if needed, and eagerly creates the `app_config` table so the JWT secret can be read at middleware load time.

## Actors

- **The host server** — The single consumer.
- **`getConnection`** — The connection factory.
- **The `app_config` table** — Created eagerly for the JWT secret.

## Trigger

- The server boots.

## Flow

1. `server/load-env.js` resolves `DATABASE_PATH` (env → CLI flag → default `~/.cloudcli/auth.db`).
2. `connection.ts` opens the SQLite handle (creating the directory if needed).
3. The `app_config` table is created **eagerly** (before full schema applies).
4. `init-db.ts` applies the full `INIT_SCHEMA_SQL` and runs migrations.
5. Repositories now point at the shared connection.

## Output

- A single, process-wide SQLite connection.
- The `app_config` table available before the full schema.
- A directory layout that survives reboots.

## Technical Mapping

- **Connection:** `server/modules/database/connection.ts`
- **Init:** `server/modules/database/init-db.ts`
- **Schema:** `server/modules/database/schema.ts`
- **Path resolution:** `server/load-env.js`, `server/utils/runtime-paths.js`

## Dependencies

- **Database Layer** — All other capabilities.
- **Authentication & Security** — Reads the JWT secret from `app_config`.
