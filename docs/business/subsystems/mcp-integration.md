# Subsystem 5: MCP Integration

## Business Purpose

The **MCP Integration** subsystem lets users configure **Model Context Protocol (MCP) servers** that the AI agents can call as tools. Each CLI provider has its own MCP config format and location; the subsystem unifies the read/write surface so users can edit a server in one provider or push it to all of them at once.

It also powers the **Browser-Use** subsystem: when the user toggles browser agent tools on, this subsystem auto-registers the `cloudcli-browser` MCP server across all providers.

## Provider MCP Config Locations

| Provider | Config Path(s) |
|----------|----------------|
| Claude | `~/.claude.json` (global + per-project) |
| Codex | `~/.codex/config.toml` |
| Cursor | `~/.cursor/mcp.json` |
| Gemini | `~/.gemini.json` |
| OpenCode | `opencode.json` |

## Key Capabilities

| Capability | Description |
|------------|-------------|
| **List servers per provider** | `listProviderMcpServers` / `listProviderMcpServersForScope` |
| **Upsert server per provider** | `upsertProviderMcpServer` — add or update with a typed payload |
| **Remove server per provider** | `removeProviderMcpServer` |
| **Scoped storage** | `user` (global) and `project` (cwd) scopes; `local` is per-CLI |
| **Add to all providers** | `addMcpServerToAllProviders` iterates the live registry |
| **Remove from all providers** | `removeMcpServerFromAllProviders` |
| **Transport support** | stdIO and HTTP transports supported for global add |
| **Browser-Use auto-register** | When `browser_use_settings.enabled` is true, registers `cloudcli-browser` stdio with a per-install bearer token |
| **Legacy name scrub** | Removes any server named `cloudcli-browser` or `cloudcli-browser-use` on unregister |
| **Per-provider adapters** | `server/modules/providers/list/<provider>/<provider>-mcp.provider.ts` |

## Stakeholders

| Stakeholder | What They Get |
|-------------|---------------|
| **End users** | A single UI to add, edit, and remove MCP servers across all providers. |
| **Power users** | A "push to all" affordance when they want a tool available to every agent. |
| **Browser-Use** | A one-line integration point that auto-registers the browser server. |
| **Plugin authors** | The same `IProviderMcp` interface to integrate new tools. |

## How It Works (Adding a Server to All Providers)

1. The user opens Settings → MCP Servers and clicks "Add server".
2. The frontend POSTs the server config to the unified MCP service.
3. `addMcpServerToAllProviders` iterates the live provider registry (so new providers are picked up automatically).
4. For each provider, the adapter writes the server to the provider's native config file in the correct format.
5. The next time the user starts a chat, the agent sees the new tool.

## Cross-Cutting Concerns

- **Provider registry** — Driven by `server/modules/providers/provider.registry.ts`; new providers are picked up automatically.
- **Authentication** — Scoped writes are authorized through the same auth middleware as REST routes.
- **Token-gated tools** — The Browser-Use MCP bridge uses a randomly generated bearer token stored in `app_config`.
- **Auto-clean** — Prevents the Browser-Use feature from leaving behind legacy server names on toggle.

## Technical Mapping (Entry Points)

- **Unified service:** `server/modules/providers/services/mcp.service.ts`
- **Base class:** `server/modules/providers/shared/mcp/mcp.provider.ts`
- **Per-provider adapters:** `server/modules/providers/list/<provider>/<provider>-mcp.provider.ts`
- **REST surface:** exposed via `server/modules/providers/provider.routes.ts`
- **Frontend view:** `src/components/mcp/view/McpServers.tsx`
- **Frontend form:** `src/components/mcp/view/modals/McpServerFormModal.tsx`
- **Frontend hooks:** `src/components/mcp/hooks/useMcpServers.ts`, `useMcpServerForm.ts`
- **Auto-registration:** `server/modules/browser-use/browser-use.service.ts`

## Capability Documents

- [capabilities/mcp-integration/server-listing-and-editing.md](capabilities/mcp-integration/server-listing-and-editing.md)
- [capabilities/mcp-integration/cross-provider-sync.md](capabilities/mcp-integration/cross-provider-sync.md)
- [capabilities/mcp-integration/browser-use-auto-register.md](capabilities/mcp-integration/browser-use-auto-register.md)
- [capabilities/mcp-integration/scope-management.md](capabilities/mcp-integration/scope-management.md)
