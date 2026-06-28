# CloudCLI UI — Business Overview

## What It Is

CloudCLI UI is a **single web/desktop application** that gives developers a unified, streaming, session-based interface for five different AI coding CLIs:

1. **Claude Code** (Anthropic) — via the official `@anthropic-ai/claude-agent-sdk`
2. **Cursor CLI** (`cursor-agent`) — via PTY
3. **Codex** (OpenAI) — via the `@openai/codex-sdk`
4. **Gemini CLI** (Google) — via PTY
5. **OpenCode** (`opencode`) — via PTY

It is an open-source fork of [`siteboon/claudecodeui`](https://github.com/siteboon/claudecodeui), published to npm as `@cloudcli-ai/cloudcli` and also available as Docker sandbox images and an Electron desktop app.

## What It Does

The app wraps each CLI in a consistent, opinionated UI that adds what the raw CLIs lack:

- **Visual chat** with message history, tool-call rendering, and token-usage tracking
- **Multi-project sidebar** with session search, archive, and restore
- **Integrated terminal** for running agent processes, watching prompt pickers, and copying auth URLs
- **File tree, in-browser editor, and Git panel** for the same workspace the agent sees
- **TaskMaster kanban** for AI-generated task planning per project
- **Browser automation** via Playwright (the agent can drive a real Chromium)
- **MCP server management** so users can plug in their own tools
- **Plugin system** for adding new tabs and backends
- **Web-push notifications** when a run finishes, errors, or needs user action
- **Multi-language UI** (ten languages) and light/dark theming

## Who Uses It

| Audience | Why They Use It |
|----------|-----------------|
| **Developers** | Want a browser/desktop UI for Claude Code and other coding CLIs instead of a terminal. |
| **Power users** | Run multiple coding agents in parallel across many projects and need session management. |
| **Self-hosters** | Run it behind a reverse proxy, in Docker, or in a Docker Sandbox microVM. |
| **Plugin authors** | Ship a tab + optional backend to extend the app. |
| **External integrators** | Call `/api/agent` from CI or scripts using a long-lived API key. |
| **New users** | Complete a guided onboarding flow that connects CLIs and sets up git identity. |

## Business Model

CloudCLI UI is an **open-source project** distributed free under the project license. The product surface is:

- **Self-hosted npm package** — `npm install -g @cloudcli-ai/cloudcli` (v1.34.0)
- **Managed cloud** — `https://cloudcli.ai` (no setup required, the only non-self-hosted route)
- **Docker Sandbox images** — `docker.io/cloudcliai/sandbox:claude-code`, `codex`, `gemini`
- **Plugin marketplace** — official plugins (project-stats, web-terminal) and community plugins

There is no per-seat license fee for the self-hosted distribution. The commercial surface is the hosted cloud offering, Docker sandbox convenience packaging, and the plugin ecosystem.

## Major Subsystems

| # | Subsystem | One-Line Purpose |
|---|-----------|------------------|
| 1 | **Chat & Agent Streaming** | Real-time chat UI + CLI provider streaming via a single WebSocket hub |
| 2 | **Terminal/Shell** | PTY-backed terminal per project, streamed over WebSocket |
| 3 | **Provider Integration** | Unified registry and runtime for all five CLI providers |
| 4 | **Plugin System** | Discover, install, enable, and lifecycle-manage third-party extensions |
| 5 | **MCP Integration** | Configure Model Context Protocol servers per provider and scope |
| 6 | **Browser-Use** | Playwright-driven browser control exposed to the agent via MCP |
| 7 | **Authentication & Security** | JWT auth, API keys, WebSocket auth, and the tool-permission model |
| 8 | **Session & Project Management** | Projects, sessions, transcripts, auto-discovery, and the sidebar payload |
| 9 | **Database Layer** | SQLite (better-sqlite3), schema, migrations, and per-table repositories |
| 10 | **Notification System** | Web push, in-app toasts, and notification preferences |
| 11 | **Distribution** | npm, Docker, Electron, and PWA packaging and deployment |
| 12 | **Internationalization & Theming** | Ten languages and light/dark theming |

## How a Chat Message Flows (End-to-End)

1. The user types a message in `ChatInterface` (`src/components/chat/view/`).
2. The frontend sends it over a shared WebSocket to `/ws` (`server/modules/websocket/`).
3. The WebSocket hub dispatches to the matching provider's spawn function (e.g. `queryClaudeSDK`, `spawnCursor`, `queryCodex`, `spawnGemini`, `spawnOpenCode`).
4. The provider streams structured events back: assistant text, tool calls, permission requests, token usage, session id.
5. The hub assigns sequence numbers, remaps the provider-native session id to a stable app id, and broadcasts to all connected clients for that session.
6. The frontend renders messages, tool output, diffs, and permission prompts.
7. When the run finishes, the notification orchestrator may send a web-push to subscribed devices.

## Key Technical Properties

- **Single Vite + React frontend** served by an **Express + ws backend** in one Node process.
- **SQLite** (better-sqlite3) for users, projects, sessions, credentials, notifications, and config.
- **WebSocket multiplexer** — one upgrade listener routes `/ws`, `/shell`, and `/plugin-ws` to the right service.
- **Provider abstraction** — `server/modules/providers/provider.registry.ts` is the single source of truth for which CLIs the app supports.
- **ESM everywhere on the backend**; TypeScript + JS mix on the frontend.
- **Two `@/` aliases** — frontend `@/*` → `src/*`, backend `@/*` → `server/*`.
- **PWA-capable** — installable on mobile and desktop, with a service worker, manifest, and web-push wiring.

## Security Posture

- **Single-user registration** with bcrypt password hashing.
- **JWT bearer tokens** (7-day HS256) with sliding refresh past the halfway point of the lifetime.
- **Long-lived API keys** (`ck_`-prefixed) for external integrations via `/api/agent`.
- **WebSocket token auth** during the upgrade handshake, with a `?token=` query-string fallback for SSE-style clients.
- **Tool permissions** are gated by the `PermissionContext` and the per-provider permission-mode matrix (default, plan, accept-edits, bypass-permissions).
- **Claude Code tools are disabled by default** in the UI — the user must opt in via the Tools Settings modal.
- **SSRF guards** on the voice proxy (allowlist http/https, block 169.254.x).
- **Plugin env hardening** — plugin processes receive a minimal environment (no host secrets).

## Distribution Channels

| Channel | Status | Notes |
|---------|--------|-------|
| **npm** (`@cloudcli-ai/cloudcli`) | Primary | v1.34.0; `cloudcli` bin runs the server from `dist-server/` |
| **Docker Sandbox** | Published | `docker.io/cloudcliai/sandbox:claude-code\|codex\|gemini` |
| **Electron desktop** | Wired | `appId: ai.cloudcli.desktop`; source not in this fork |
| **PWA** | Active | Installable; service worker + manifest + web-push |
| **Cloud (cloudcli.ai)** | External | Managed offering; code not in this repo |

## Where to Go Next

- **[subsystems/](subsystems/)** — Twelve subsystem overviews.
- **[capabilities/](capabilities/)** — Detailed business capability docs, organized by subsystem.
- **`CLAUDE.md`** — Developer guidance, architecture, and editing checklist.
