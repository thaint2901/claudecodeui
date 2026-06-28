# Capability: Server Listing & Editing

## Description

Lists, creates, updates, and deletes MCP servers per provider and per scope. Each provider has its own config file format; the unified service adapts reads and writes through the registry so the UI can edit any provider in one place.

## Actors

- **End user** — Manages MCP servers in Settings → MCP Servers.
- **The unified MCP service** — Routes requests to the right provider adapter.
- **The provider MCP adapter** — Reads/writes the provider's native config.
- **The agent** — Sees the configured servers as available tools.

## Trigger

- The user opens Settings → MCP Servers.
- The user clicks **Add** / **Edit** / **Delete** for a server.
- The agent starts a chat and needs to know which tools are available.

## Flow (List)

1. The frontend calls `GET /api/providers/:provider/mcp-servers` (or the per-scope variant).
2. The unified service looks up the provider's adapter.
3. The adapter reads the provider's native config file.
4. The result is normalized and returned.

## Flow (Upsert)

1. The frontend posts a server config to the unified service.
2. The service looks up the provider's adapter.
3. The adapter writes the server to the provider's native config in the correct format.
4. The agent sees the new tool on the next chat.

## Output

- A list of MCP servers per provider and scope.
- A new / updated / removed server in the provider's config.
- A new tool available to the agent.

## Technical Mapping

- **Backend service:** `server/modules/providers/services/mcp.service.ts`
- **Backend base:** `server/modules/providers/shared/mcp/mcp.provider.ts`
- **Backend adapters:** `server/modules/providers/list/<provider>/<provider>-mcp.provider.ts`
- **REST:** `server/modules/providers/provider.routes.ts`
- **Frontend UI:** `src/components/mcp/view/McpServers.tsx`
- **Frontend form:** `src/components/mcp/view/modals/McpServerFormModal.tsx`
- **Frontend hooks:** `src/components/mcp/hooks/useMcpServers.ts`, `useMcpServerForm.ts`

## Dependencies

- **Provider Integration** — Per-provider config format.
- **Authentication & Security** — Authenticated route access.
