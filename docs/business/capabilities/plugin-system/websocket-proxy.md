# Capability: WebSocket Proxy

## Description

Proxies WebSocket traffic from `/plugin-ws/<pluginName>` to the plugin's local port (`ws://127.0.0.1:<port>/ws`). The host authenticates the connection at upgrade time; the plugin sees a plain WebSocket on its end.

## Actors

- **End user** — A browser client (or another tool) opening a WebSocket to the plugin.
- **The WebSocket hub** — Routes `/plugin-ws/<pluginName>` to the proxy.
- **The plugin's server** — Handles the WebSocket on its local port.

## Trigger

- A client opens `wss://<host>/plugin-ws/<pluginName>`.

## Flow

1. The client opens a WebSocket to `/plugin-ws/<pluginName>`.
2. The hub authenticates the upgrade (same JWT as `/ws` and `/shell`).
3. The hub looks up the plugin's port from `plugin-process-manager`.
4. The hub opens a client WebSocket to `ws://127.0.0.1:<port>/ws`.
5. Frames flow bidirectionally; the hub copies each frame in both directions.
6. On either side disconnect, the other side is closed.

## Output

- A transparent WebSocket proxy that lets the plugin speak plain `ws://` to the host.

## Technical Mapping

- **Backend:** `server/modules/websocket/services/plugin-websocket-proxy.service.ts`
- **Wiring:** `server/modules/websocket/services/websocket-server.service.ts` (pathname routing)
- **Process manager:** `server/utils/plugin-process-manager.js` (port lookup)

## Dependencies

- **Plugin System** — Server process lifecycle (port tracking).
- **Authentication & Security** — WebSocket upgrade auth.
- **Chat & Agent Streaming** — Shares the WebSocket hub.
