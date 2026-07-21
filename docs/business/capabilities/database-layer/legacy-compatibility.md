# Capability: Legacy Compatibility

## Status

This capability is no longer applicable. Provider-specific legacy compatibility files have been removed. The new `server/modules/database/` layout is now the standard for all supported providers.

## Technical Mapping

- **New layout:** `server/modules/database/` (standard for all providers)
- **Supported providers:** Claude, Cursor, Codex, OpenCode

## Dependencies

- **Database Layer** — Repositories, schema & migrations.
- **Provider Integration** — Active provider runtimes.
