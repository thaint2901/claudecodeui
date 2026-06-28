# Subsystem 6: Browser-Use

## Business Purpose

The **Browser-Use** subsystem lets the AI agent (and the UI directly) drive a real **headless Chromium browser** via Playwright. It exposes a **token-gated MCP server** so any MCP-aware agent can call browser tools, plus a **REST bridge** for direct UI control. Persistent per-profile contexts let the agent log into sites and keep cookies across runs.

The subsystem is the "let the agent use a browser" feature — useful for scraping, automation, and web-based research tasks the agent can stream back to the user.

## Key Capabilities

| Capability | Description |
|------------|-------------|
| **Settings toggle** | `enabled/disabled` flag persisted in `appConfigDb` (key `browser_use_settings`) |
| **Runtime readiness probe** | Detects Playwright install + Chromium executable via `playwright.chromium.executablePath()`; cached 30s |
| **Runtime install** | `npm install --no-save playwright` + `playwright install-deps chromium` (Linux) + `playwright install chromium` (10 min timeout) |
| **Per-owner session cap** | `MAX_SESSIONS_PER_OWNER=3`; TTL expiry (30 min default) with auto-stop on staleness |
| **Persistent profiles** | `~/.cloudcli/browser-use/profiles/<name>` via `launchPersistentContext`; cookies/storage persist |
| **Per-action screenshot** | Captures a JPEG (quality 72) as a data URL on the session |
| **Body innerText snapshot** | Capped at 30 KB |
| **Click by selector / text / coords** | CSS selector, visible text, or x/y |
| **Type with submit** | Optional `submit:true` to press Enter |
| **Fill form** | Multi-field `fill_form` |
| **Press key / select option** | Standard keyboard and `<select>` interactions |
| **Wait for** | Text, URL pattern, or timeout |
| **Tabs** | List, new, select, close |
| **MCP tool surface** | `browser_create_session`, `browser_list_sessions`, `browser_snapshot`, `browser_take_screenshot`, `browser_navigate`, `browser_click`, `browser_type`, `browser_fill_form`, `browser_press_key`, `browser_select_option`, `browser_wait_for`, `browser_tabs`, `browser_close_session` |
| **stdio MCP server** | Newline-delimited JSON-RPC over stdio (`server/browser-use-mcp.ts`) |
| **HTTP bridge** | `/api/browser-use-mcp/tools/:toolName` with bearer token (`CLOUDCLI_BROWSER_USE_MCP_TOKEN`) or `x-browser-use-mcp-token` header |
| **Auto-register MCP** | `cloudcli-browser` stdio entry registered across all providers when browser tools are toggled on |
| **Graceful shutdown** | `stopAllSessions` on `SIGTERM`/`SIGINT`/`beforeExit` — no zombie Chromium processes |

## Stakeholders

| Stakeholder | What They Get |
|-------------|---------------|
| **End users** | A toggle that lets the agent drive a browser on their behalf. |
| **The LLM agent** | A set of MCP tools to browse, click, type, and snapshot the web. |
| **Power users** | A REST bridge for direct browser control from the UI. |
| **Operators** | Auto-cleaned sessions, capped per owner, and no zombie processes on shutdown. |

## How It Works (Agent-Driven Flow)

1. The user toggles **Browser agent tools** on in Settings.
2. The browser-use service auto-registers the `cloudcli-browser` stdio MCP server across all providers (handled by the MCP subsystem).
3. The user sends a chat message asking the agent to "go to example.com and fill the form".
4. The provider invokes the browser MCP tool `browser_create_session` (with optional `profileName`).
5. The MCP server proxies the call to `/api/browser-use-mcp/tools/browser_create_session` with the bearer token.
6. The browser-use service creates a Playwright session, returns the `sessionId`.
7. The agent calls `browser_navigate`, `browser_click`, `browser_type`, etc.
8. Each call returns a screenshot data URL and/or text snapshot.
9. The user watches the live browser output in the **Browser-Use** panel; the agent's commentary flows into the chat.
10. On session end, the session is auto-closed (or expires after 30 min TTL).

## Cross-Cutting Concerns

- **MCP integration** — Auto-registration is the bridge to all providers.
- **Token-gated bridge** — Per-install bearer token in `app_config`; legacy plugin names scrubbed on unregister.
- **Session limits** — `MAX_SESSIONS_PER_OWNER=3` prevents resource exhaustion; TTL prevents leaks.
- **Profile persistence** — Lets the agent log in once and reuse cookies across sessions.
- **Graceful shutdown** — `stopAllSessions` on server exit so no Chromium processes survive.

## Technical Mapping (Entry Points)

- **Service:** `server/modules/browser-use/browser-use.service.ts`
- **REST routes:** `server/modules/browser-use/browser-use.routes.ts`
- **MCP bridge routes:** `server/modules/browser-use/browser-use-mcp.routes.ts`
- **stdio MCP server:** `server/browser-use-mcp.ts`
- **Frontend panel:** `src/components/browser-use/view/BrowserUsePanel.tsx`
- **Settings tab:** `src/components/settings/view/tabs/browser-use-settings/BrowserUseSettingsTab.tsx`
- **Auto-register call:** `server/modules/browser-use/browser-use.service.ts` → `server/modules/providers/services/mcp.service.ts`

## Capability Documents

- [capabilities/browser-use/runtime-and-installation.md](capabilities/browser-use/runtime-and-installation.md)
- [capabilities/browser-use/session-and-profile-management.md](capabilities/browser-use/session-and-profile-management.md)
- [capabilities/browser-use/mcp-tool-surface.md](capabilities/browser-use/mcp-tool-surface.md)
- [capabilities/browser-use/auto-register-with-providers.md](capabilities/browser-use/auto-register-with-providers.md)
- [capabilities/browser-use/graceful-shutdown.md](capabilities/browser-use/graceful-shutdown.md)
