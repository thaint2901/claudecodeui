# Capability: MCP Tool Surface

## Description

Exposes a set of MCP tools that any MCP-aware agent (or the UI directly) can call to drive the browser: navigate, click, type, fill form, press key, select option, wait for, snapshot, take screenshot, manage tabs. Each call returns a screenshot data URL and/or a text snapshot.

## Actors

- **The LLM agent** — Calls the tools via MCP.
- **The browser-use MCP bridge** — Authenticates and dispatches.
- **The browser-use REST service** — Executes the action.
- **The browser session** — A live Playwright page.

## Trigger

- The agent decides it needs to interact with the web.
- The UI's Browser-Use panel calls a tool directly.

## Flow

1. The agent sends an MCP `tools/call` request (or the UI calls a REST endpoint) with the tool name and params.
2. The bridge authenticates the bearer token.
3. The service looks up the session by `sessionId`.
4. The action is performed on the live page (e.g. `page.click(selector)`).
5. A screenshot (JPEG quality 72) is captured as a data URL.
6. (For `browser_snapshot`) The body `innerText` is returned (capped at 30 KB).
7. The result is returned to the caller.

## Tool List

| Tool | Purpose |
|------|---------|
| `browser_create_session` | Create a session (with optional `profileName`) |
| `browser_list_sessions` | List live sessions |
| `browser_close_session` | Close a session |
| `browser_navigate` | Navigate to a URL |
| `browser_snapshot` | Capture the page's text + screenshot |
| `browser_take_screenshot` | Take a screenshot only |
| `browser_click` | Click by CSS selector / text / x,y |
| `browser_type` | Type into a field (optionally submit) |
| `browser_fill_form` | Multi-field fill |
| `browser_press_key` | Press a keyboard key |
| `browser_select_option` | Pick an `<option>` |
| `browser_wait_for` | Wait for text / URL / timeout |
| `browser_tabs` | List / new / select / close |

## Output

- A screenshot data URL and/or text snapshot per call.
- A changed page state for the session.
- (On error) An error message returned to the caller.

## Technical Mapping

- **Backend:** `server/modules/browser-use/browser-use.service.ts`
- **MCP bridge:** `server/modules/browser-use/browser-use-mcp.routes.ts`
- **stdio MCP server:** `server/browser-use-mcp.ts`
- **REST bridge:** `POST /api/browser-use-mcp/tools/:toolName`
- **Auth:** Bearer token (`CLOUDCLI_BROWSER_USE_MCP_TOKEN`) or `x-browser-use-mcp-token` header

## Dependencies

- **Browser-Use** — Runtime & session management.
- **MCP Integration** — Auto-registers the `cloudcli-browser` server.
- **Authentication & Security** — Bearer-token bridge.
