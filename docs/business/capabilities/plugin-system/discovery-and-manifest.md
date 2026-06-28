# Capability: Discovery & Manifest

## Description

Scans `~/.claude-code-ui/plugins` and validates each plugin's `manifest.json` against an allow-list of types, slots, and fields. Loads `plugins.json` to determine which plugins are enabled. The manifest is the single source of truth for what a plugin is and what it can do.

## Actors

- **End user** — Browses installed plugins in Settings → Plugins.
- **The plugin loader** — Scans the filesystem and validates manifests.
- **`plugins.json`** — The persisted enabled/disabled state (mode 0o600).
- **The frontend** — Renders the plugin list and recommendation list.

## Trigger

- The server boots (`plugin-loader.js` runs on startup).
- The user opens Settings → Plugins.
- A plugin is installed, updated, or uninstalled.

## Flow

1. On boot, `plugin-loader.js` scans `~/.claude-code-ui/plugins` for directories.
2. Each directory's `manifest.json` is parsed and validated:
   - `name` — must be unique
   - `displayName` — human-readable label
   - `entry` — path to the frontend entry module
   - `server` — path to the optional Node backend
   - `slot` — must be in `['tab']`
   - `type` — must be in `['react', 'module']`
   - `permissions` — declared permissions
3. `plugins.json` is loaded; enabled state is merged with the manifest.
4. The frontend `/api/plugins` returns the merged list.
5. The user can install, enable, disable, update, or uninstall.

## Output

- A validated, merged plugin registry.
- A list rendered in Settings → Plugins.
- Enabled state persisted to `plugins.json`.

## Technical Mapping

- **Backend loader:** `server/utils/plugin-loader.js`
- **Backend config:** `plugins.json` (mode 0o600)
- **Backend routes:** `server/routes/plugins.js`
- **Frontend context:** `src/contexts/PluginsContext.tsx`
- **Frontend UI:** `src/components/plugins/view/PluginSettingsTab.tsx`

## Dependencies

- **Plugin System** — Lifecycle and process management.
- **Database Layer** — Filesystem path resolution (`runtime-paths.js`).
- **Authentication & Security** — Authenticated route access.
