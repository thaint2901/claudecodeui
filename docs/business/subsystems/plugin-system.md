# Subsystem 4: Plugin System

## Business Purpose

The **Plugin System** lets third-party developers extend CloudCLI UI without forking the app. A plugin can ship a **frontend** (a new tab in the UI) and an **optional Node.js backend** (a server process the host spawns and proxies WebSocket/RPC to). Users discover, install, enable, update, and uninstall plugins from Settings → Plugins.

The plugin system is the long-term extension surface for the app: features that don't need to ship in core land here, and the starter template (`plugins/starter/`) gives authors a working baseline.

## Key Capabilities

| Capability | Description |
|------------|-------------|
| **Plugin discovery** | Scan `~/.claude-code-ui/plugins` and validate each `manifest.json` against the allow-list. |
| **Install from Git** | Clone `--depth 1` from a sanitized URL, run `npm install --ignore-scripts`, optionally `npm run build` (60s timeout), atomically rename into the plugins dir. |
| **Update** | `git pull --ff-only`, re-validate manifest, reinstall deps. |
| **Uninstall** | Stop the server subprocess if running, retry `rm` on EBUSY, remove from `plugins.json`. |
| **Enable / disable** | Persist per-plugin in `plugins.json` (mode 0o600); start/stop the server subprocess. |
| **Manifest validation** | `name`, `displayName`, `entry`, `server`, `slot`, `permissions` — types and slots must be in allow-lists. |
| **Server subprocess** | `plugin-process-manager` spawns `node server.js`, waits for `{ready:true,port:N}` JSON line on stdout (10s timeout), SIGTERM then SIGKILL on shutdown. |
| **Minimal env propagation** | Only `PATH`, `HOME`, `NODE_ENV`, `PLUGIN_NAME` + Windows essentials — no host secrets leak. |
| **WebSocket proxy** | `/plugin-ws/<pluginName>` → `ws://127.0.0.1:<port>/ws` via `plugin-websocket-proxy.service.ts`. |
| **Asset serving** | Plugin static assets served with no-cache headers. |
| **Asset path safety** | Realpath canonicalization defends against path traversal and symlink bypasses. |
| **Recommendation list** | In-Settings list of official (project-stats, web-terminal) and community plugins (claude-watch, cron, prism, session-manager, token-cost, task-queue, github-issues). |
| **Auto-clean** | Server-side unregister of any plugin named `cloudcli-browser` or `cloudcli-browser-use` from MCP configs. |
| **Graceful shutdown** | `stopAllPlugins` called on host `SIGTERM`/`SIGINT`/`beforeExit`. |

## Plugin Lifecycle

```
discover
  → scan ~/.claude-code-ui/plugins, validate manifest.json
  → load plugins.json
install
  → git clone --depth 1 to .tmp-*
  → npm install --ignore-scripts
  → optional npm run build (60s timeout)
  → atomic rename to plugins/<name>
  → write plugins.json
enable
  → if manifest.server set: start server subprocess
  → persist enabled=true
update
  → git pull --ff-only
  → re-validate manifest
  → reinstall deps
uninstall
  → SIGTERM server if running
  → retry rm on EBUSY
  → remove from plugins.json
shutdown
  → stopAllPlugins on host exit
```

## Stakeholders

| Stakeholder | What They Get |
|-------------|---------------|
| **End users** | A growing catalog of features (stats, web terminal, cron, GitHub issues, etc.) installable in one click. |
| **Plugin authors** | A documented manifest, a starter template, and a stable extension point that doesn't require forking. |
| **Core maintainers** | A safe place to put features that don't need to ship in the core bundle. |
| **Operators** | A small, env-hardened subprocess footprint with no leaked host secrets. |

## How a Plugin Tab Renders

1. The user opens Settings → Plugins and installs a plugin (git URL or recommendation).
2. The host validates the manifest, clones the repo, runs `npm install` + optional build, and writes `plugins.json`.
3. If `manifest.server` is set, `plugin-process-manager` spawns `node server.js` and waits for the ready JSON line.
4. `PluginsContext` (`src/contexts/PluginsContext.tsx`) fetches `/api/plugins` and exposes the registry.
5. The plugin's tab is rendered by loading its `entry` module at runtime; its server is reachable via the WebSocket proxy.
6. The user can disable, update, or uninstall the plugin at any time.

## Cross-Cutting Concerns

- **Security** — Asset path resolution defends against traversal; minimal env propagation prevents secret leakage.
- **Filesystem layout** — `PLUGINS_DIR` and `PLUGINS_CONFIG_PATH` are resolved at boot by `server/utils/runtime-paths.js`.
- **WebSocket routing** — The central WS hub routes `/plugin-ws/<pluginName>` to the proxy service.
- **MCP integration** — Plugins can register MCP servers; the auto-clean step scrubs known internal plugin names.
- **Permissions** — The manifest's `permissions` field declares what the plugin requests (TBD enforcement).

## Technical Mapping (Entry Points)

- **Backend routes:** `server/routes/plugins.js`
- **Loader:** `server/utils/plugin-loader.js`
- **Process manager:** `server/utils/plugin-process-manager.js`
- **WebSocket proxy:** `server/modules/websocket/services/plugin-websocket-proxy.service.ts`
- **Frontend context:** `src/contexts/PluginsContext.tsx`
- **Frontend views:** `src/components/plugins/view/PluginSettingsTab.tsx`, `PluginTabContent.tsx`, `PluginIcon.tsx`
- **Starter template:** `plugins/starter/`, public template at `cloudcli-plugin-starter`

## Capability Documents

- [capabilities/plugin-system/discovery-and-manifest.md](capabilities/plugin-system/discovery-and-manifest.md)
- [capabilities/plugin-system/install-update-uninstall.md](capabilities/plugin-system/install-update-uninstall.md)
- [capabilities/plugin-system/server-process-lifecycle.md](capabilities/plugin-system/server-process-lifecycle.md)
- [capabilities/plugin-system/frontend-tab-mounting.md](capabilities/plugin-system/frontend-tab-mounting.md)
- [capabilities/plugin-system/websocket-proxy.md](capabilities/plugin-system/websocket-proxy.md)
- [capabilities/plugin-system/security-and-env-hardening.md](capabilities/plugin-system/security-and-env-hardening.md)
