# Capability: Cross-Provider Sync

## Description

Adds or removes an MCP server across all providers at once. Iterates the live provider registry so new providers are picked up automatically. Supports stdIO and HTTP transports for the global add.

## Actors

- **End user** — Clicks **Add to all providers** in the MCP form.
- **The unified MCP service** — Iterates the registry.
- **Each provider's adapter** — Writes the server in the provider's format.

## Trigger

- The user adds a server with the "all providers" option.
- The user removes a server with the "all providers" option.

## Flow (Add to All)

1. The frontend posts a server config with `target: 'all'`.
2. `addMcpServerToAllProviders` iterates the live provider registry.
3. For each provider, the adapter writes the server to the provider's native config.
4. The agent sees the tool in every provider on the next chat.

## Flow (Remove from All)

1. The frontend posts a removal request with `target: 'all'`.
2. `removeMcpServerFromAllProviders` iterates the registry.
3. For each provider, the adapter removes the server.
4. The tool disappears from every provider.

## Output

- A server present (or absent) in every provider's config.
- A consistent tool surface across all agents.

## Technical Mapping

- **Backend service:** `server/modules/providers/services/mcp.service.ts` (`addMcpServerToAllProviders`, `removeMcpServerFromAllProviders`)
- **Backend registry:** `server/modules/providers/provider.registry.ts`

## Dependencies

- **Provider Integration** — Provider registry iteration.
- **MCP Integration** — Per-provider adapter.
