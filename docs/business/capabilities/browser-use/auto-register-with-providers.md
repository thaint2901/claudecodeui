# Capability: Auto-Register with Providers

## Description

When the user toggles **Browser agent tools** on, the `cloudcli-browser` stdio MCP server is registered across all providers (Claude, Cursor, Codex, Gemini, OpenCode). When the user toggles it off, the server is removed. Legacy names (`cloudcli-browser-use`) are scrubbed on unregister.

## Actors

- **End user** — Toggles the setting.
- **The browser-use service** — Triggers the register/unregister.
- **The MCP service** — Performs the cross-provider add/remove.

## Trigger

- `browser_use_settings.enabled` becomes `true` in `appConfigDb`.
- `browser_use_settings.enabled` becomes `false`.

## Flow (Enable)

1. The user toggles the setting on.
2. The browser-use service calls `addMcpServerToAllProviders` with the `cloudcli-browser` stdio entry (process.execPath + `server/browser-use-mcp.js`).
3. The server is registered in every provider's native config.
4. A per-install bearer token is generated and stored in `app_config`.
5. The agent sees the browser tools on the next chat.

## Flow (Disable)

1. The user toggles the setting off.
2. The browser-use service calls `removeMcpServerFromAllProviders` with the `cloudcli-browser` name and the `cloudcli-browser-use` legacy name.
3. The server and legacy variants are removed from every provider.
4. The browser tools disappear from every agent.

## Output

- A consistent toggle that lights up browser tools in every agent.
- A clean teardown on disable.

## Technical Mapping

- **Backend service:** `server/modules/browser-use/browser-use.service.ts`
- **MCP service:** `server/modules/providers/services/mcp.service.ts`
- **Settings persistence:** `appConfigDb` (key `browser_use_settings`)

## Dependencies

- **MCP Integration** — Cross-provider add/remove.
- **Provider Integration** — Per-provider config format.
