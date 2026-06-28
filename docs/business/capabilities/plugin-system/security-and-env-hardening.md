# Capability: Security & Env Hardening

## Description

Defends the host against malicious or careless plugins. Asset path resolution uses realpath canonicalization to prevent path traversal and symlink bypasses. Plugin processes receive a minimal environment so host secrets don't leak. Manifest validation enforces allow-lists for types, slots, and fields.

## Actors

- **The host operator** — Wants plugins to be safe to install.
- **The asset resolver** — Uses realpath to prevent traversal.
- **The process manager** — Strips the env before spawn.
- **The manifest validator** — Enforces the schema.

## Trigger

- A user installs a plugin.
- A plugin's frontend is mounted.
- A plugin's backend starts.

## Flow (Asset Path Safety)

1. The frontend requests `/api/plugins/<name>/assets/<path>`.
2. The loader resolves the plugin's assets dir via `realpath`.
3. The requested path is joined and re-resolved via `realpath`.
4. If the result is outside the assets dir, the request is denied.
5. Symlinks that would resolve outside are also denied.

## Flow (Env Hardening)

1. The process manager builds a minimal env: `PATH`, `HOME`, `NODE_ENV`, `PLUGIN_NAME`, and (on Windows) Windows essentials.
2. The host's secrets (`JWT_SECRET`, `API_KEY`, etc.) are NOT passed.
3. The plugin's process sees only what the host explicitly chose to pass.

## Flow (Manifest Validation)

1. The loader parses `manifest.json`.
2. The schema is validated: `type` in `['react', 'module']`, `slot` in `['tab']`, etc.
3. Invalid manifests are rejected; the plugin is not loaded.

## Output

- Path-traversal-safe asset serving.
- No host-secret leakage to plugin processes.
- A predictable, validated plugin surface.

## Technical Mapping

- **Backend:** `server/utils/plugin-loader.js` (asset resolution, manifest validation)
- **Backend:** `server/utils/plugin-process-manager.js` (env stripping)
- **Backend:** `server/routes/plugins.js` (asset route)

## Dependencies

- **Plugin System** — All other capabilities.
- **Authentication & Security** — Shared security model.
