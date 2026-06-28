# Capability: Install / Update / Uninstall

## Description

Install a plugin from a Git URL, update it to the latest version, or uninstall it cleanly. All three operations go through the same atomic rename pattern (clone to `.tmp-*`, then rename) to avoid scan-time races.

## Actors

- **End user** — Installs/updates/uninstalls a plugin.
- **The plugin loader** — Orchestrates the operations.
- **The filesystem** — Holds the plugin code and config.

## Trigger

- The user clicks **Install** in Settings → Plugins with a Git URL.
- The user clicks **Update** for a plugin.
- The user clicks **Uninstall** for a plugin.

## Flow (Install)

1. The user pastes a Git URL and clicks **Install**.
2. The URL is sanitized (no `..`, no non-git schemes).
3. `git clone --depth 1 <url> .tmp-<name>` runs.
4. `npm install --ignore-scripts` runs in the temp dir.
5. If `manifest.scripts.build` is set, `npm run build` runs (60s timeout).
6. The temp dir is atomically renamed to `plugins/<name>`.
7. `plugins.json` is updated to include the new plugin (disabled by default).

## Flow (Update)

1. The user clicks **Update** for a plugin.
2. `git pull --ff-only` runs in the plugin dir.
3. The manifest is re-validated.
4. `npm install --ignore-scripts` re-runs.
5. If a build is configured, it re-runs.
6. The plugin's server (if any) is restarted.

## Flow (Uninstall)

1. The user clicks **Uninstall** for a plugin.
2. If the server is running, it is SIGTERMed.
3. The plugin dir is removed (retry on EBUSY).
4. `plugins.json` is updated to remove the entry.
5. The plugin's tab is unmounted in the UI.

## Output

- A new / updated / removed plugin on disk.
- `plugins.json` updated.
- Server subprocess started / stopped as needed.

## Technical Mapping

- **Backend:** `server/utils/plugin-loader.js`
- **Backend routes:** `server/routes/plugins.js`
- **Backend config:** `plugins.json` (mode 0o600)
- **Frontend:** `src/contexts/PluginsContext.tsx` (install/uninstall/update/toggle)

## Dependencies

- **Plugin System** — Discovery & manifest, server lifecycle.
- **Database Layer** — Filesystem path resolution.
- **Authentication & Security** — Authenticated route access.
