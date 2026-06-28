# Capability: Browser-Use Auto-Register

## Description

When the user toggles **Browser agent tools** on in Settings, the `cloudcli-browser` stdio MCP server is automatically registered across all providers. When the user toggles it off, the server is removed from all providers. Legacy names (`cloudcli-browser-use`) are scrubbed on unregister.

## Actors

- **End user** — Toggles the browser setting.
- **The browser-use service** — Triggers the auto-register.
- **The unified MCP service** — Performs the cross-provider add/remove.
- **Each provider's adapter** — Writes/erases the stdio entry.

## Trigger

- `browser_use_settings.enabled` becomes `true` in `appConfigDb`.
- `browser_use_settings.enabled` becomes `false`.

## Flow (Enable)

1. The user toggles **Browser agent tools** on.
2. The browser-use service calls `addMcpServerToAllProviders` with:
   - `name: 'cloudcli-browser'`
   - `transport: 'stdio'`
   - `command: process.execPath + server/browser-use-mcp.js` (or `cloudcli browser-use-mcp` bin)
   - `env: { CLOUDCLI_BROWSER_USE_MCP_TOKEN, CLOUDCLI_BROWSER_USE_API_URL }`
3. The server is registered in every provider's config.
4. The agent sees the browser tools on the next chat.

## Flow (Disable)

1. The user toggles **Browser agent tools** off.
2. The browser-use service calls `removeMcpServerFromAllProviders` with:
   - `name: 'cloudcli-browser'`
   - `legacyNames: ['cloudcli-browser-use']`
3. The server and any legacy variants are erased from every provider.

## Output

- The browser tools available (or unavailable) in every agent.
- A consistent toggle: one switch, all providers.

## Technical Mapping

- **Trigger:** `server/modules/browser-use/browser-use.service.ts` (auto-register on enable/disable)
- **Backend service:** `server/modules/providers/services/mcp.service.ts`
- **Backend adapters:** `server/modules/providers/list/<provider>/<provider>-mcp.provider.ts`

## Dependencies

- **Browser-Use** — The feature that drives the toggle.
- **MCP Integration** — The cross-provider add/remove.
- **Provider Integration** — Per-provider config format.
