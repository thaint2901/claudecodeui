# Capability: Legacy Compatibility

## Description

A migration window during which a few legacy runtime files are whitelisted by ESLint and continue to be used: `server/sessionManager.js` (the legacy Gemini in-memory + JSON store) and `server/utils/runtime-paths.js` (the legacy path resolution). The new `server/modules/database/` layout is the target; the migration is in progress.

## Actors

- **The Gemini runtime** — Still uses `sessionManager.js`.
- **The legacy Gemini routes** — `server/routes/gemini.js` reads from both the new `sessions` table and the legacy `sessionManager`.
- **ESLint** — Whitelists the legacy files via `eslint.config.js`.

## Trigger

- A Gemini session is created (legacy store is written).
- A Gemini session is deleted (both stores are cleaned).

## Flow (Gemini Session Create)

1. The Gemini runtime creates a session in the legacy `sessionManager` (in-memory + JSON).
2. The runtime also writes a row to the new `sessions` table.
3. Both stores are kept in sync (best-effort).

## Flow (Gemini Session Delete)

1. The legacy route deletes from both stores.
2. The migration window ensures both paths work.

## Output

- A working Gemini integration during the migration.
- A path to consolidate into the new `sessions` table over time.

## Technical Mapping

- **Legacy runtime:** `server/sessionManager.js`
- **Legacy routes:** `server/routes/gemini.js`, `server/gemini-response-handler.js`
- **New layout:** `server/modules/database/`
- **ESLint whitelist:** `eslint.config.js` (`boundaries` plugin)

## Dependencies

- **Database Layer** — Repositories, schema & migrations.
- **Provider Integration** — Gemini runtime.
