# Capability: Server Process Lifecycle

## Description

Spawns and supervises the Node.js backend process for each enabled plugin that declares a `server` field. The process manager tracks ports, waits for a ready handshake, and shuts processes down cleanly on host exit.

## Actors

- **End user** — Enables a plugin with a server.
- **`plugin-process-manager`** — Spawns and supervises the process.
- **The plugin's server** — A Node.js process bound to a local port.
- **The host server** — Proxies WebSocket and REST to the plugin.

## Trigger

- The host boots; for each enabled plugin with a `server` field, the manager spawns the process.
- The user enables a plugin that has a `server` field (the manager starts it).
- The user disables a plugin (the manager stops it).
- The host receives `SIGTERM`/`SIGINT`/`beforeExit` (all plugin processes are stopped).

## Flow (Start)

1. The manager spawns `node <plugin>/server.js` with a minimal env (`PATH`, `HOME`, `NODE_ENV`, `PLUGIN_NAME` + Windows essentials).
2. The manager reads stdout for a JSON line of the form `{"ready": true, "port": <n>}`.
3. The handshake has a 10s timeout; on success, the port is recorded.
4. The plugin is now reachable via the WebSocket proxy (`/plugin-ws/<name>`) and any direct REST routes it exposes.

## Flow (Stop)

1. The manager sends SIGTERM to the plugin process.
2. After a grace period, SIGKILL is sent.
3. The port is released.

## Output

- A running plugin backend per enabled plugin.
- A clean shutdown on host exit.
- No leaked ports or processes.

## Technical Mapping

- **Backend:** `server/utils/plugin-process-manager.js`
- **Wiring:** `server/modules/websocket/services/plugin-websocket-proxy.service.ts`
- **Host lifecycle:** `server/index.js` (`stopAllPlugins` on shutdown)

## Dependencies

- **Plugin System** — Discovery, install, enable.
- **Authentication & Security** — Minimal env propagation (no host secrets).
- **Distribution** — Plugin process started as part of the same Node process tree.
