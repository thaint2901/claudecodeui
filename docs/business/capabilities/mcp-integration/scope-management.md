# Capability: Scope Management

## Description

MCP servers can be stored at three scopes: **user** (global, applies to every project), **project** (applies only in the project's cwd), and **local** (per-CLI, native to the provider's own per-project config). The unified service routes reads and writes to the right location based on the requested scope.

## Actors

- **End user** — Picks a scope when adding a server.
- **The unified MCP service** — Routes to the right config file.
- **The provider's adapter** — Knows where each scope lives in its native config.

## Trigger

- The user adds a server and picks a scope.
- The agent starts a chat and needs to know which servers apply to the project.

## Flow (Add at User Scope)

1. The user adds a server with `scope: 'user'`.
2. The adapter writes to the global config (`~/.claude.json`, `~/.codex/config.toml`, etc.).
3. The server is available in every project.

## Flow (Add at Project Scope)

1. The user adds a server with `scope: 'project'`.
2. The adapter writes to the per-project config in the project's cwd.
3. The server is available only in that project.

## Flow (List per Scope)

1. The frontend requests `listProviderMcpServersForScope(provider, scope)`.
2. The adapter reads only the config files for that scope.
3. The result is returned.

## Output

- A server scoped to the user's intent.
- A consistent model across all providers (user / project / local).

## Technical Mapping

- **Backend service:** `server/modules/providers/services/mcp.service.ts` (`listProviderMcpServersForScope`)
- **Backend base:** `server/modules/providers/shared/mcp/mcp.provider.ts`
- **Backend adapters:** `server/modules/providers/list/<provider>/<provider>-mcp.provider.ts`

## Dependencies

- **MCP Integration** — Per-provider adapter.
- **Session & Project Management** — Project cwd resolution.
