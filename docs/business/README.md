# CloudCLI UI — Business Documentation

This directory contains the business-level documentation for CloudCLI UI (published as `@cloudcli-ai/cloudcli`), a web/desktop UI for **Claude Code**, **Cursor CLI**, **Codex**, **Gemini CLI**, and **OpenCode**. It complements the technical documentation in `docs/` and the developer guidance in `CLAUDE.md`.

## What This Documentation Is

- **Business-oriented.** Describes *what* the system does, *who* it serves, and *why* — not the implementation details.
- **Structured by subsystem and capability.** Each subsystem has a Level 1 overview and one or more Level 2 capability files.
- **Linked to technical artifacts.** Each capability doc maps back to the server modules and frontend components that implement it, so a reader can jump from a business concept to the source.

## Who Should Read This

| Reader | Start Here |
|--------|------------|
| New engineer onboarding to the codebase | `overview.md` → `subsystems/` |
| Product manager scoping a new feature | `subsystems/<feature>.md` → `capabilities/<feature>/` |
| Stakeholder evaluating the project | `overview.md` |
| Architect designing integrations | `subsystems/provider-integration.md` and `subsystems/plugin-system.md` |
| Operator deploying or self-hosting | `subsystems/distribution.md` |
| Plugin author | `subsystems/plugin-system.md` and `capabilities/plugin-system/` |

## How to Navigate

1. **`overview.md`** — One-page business summary: what it is, who uses it, how it makes money, and the major subsystems.
2. **`subsystems/<name>.md`** — Level 1: the business purpose, key capabilities, stakeholders, and cross-cutting concerns for each of the twelve subsystems.
3. **`capabilities/<subsystem>/<capability>.md`** — Level 2: detailed business capability docs with description, actors, trigger, flow, output, technical mapping, and dependencies.

## Subsystem Index

| # | Subsystem | Purpose | Doc |
|---|-----------|---------|-----|
| 1 | Chat & Agent Streaming | Real-time chat UI + CLI provider streaming | [subsystems/chat-and-agent-streaming.md](subsystems/chat-and-agent-streaming.md) |
| 2 | Terminal/Shell | PTY-based terminal emulation | [subsystems/terminal-shell.md](subsystems/terminal-shell.md) |
| 3 | Provider Integration | Five CLI providers (Claude, Cursor, Codex, Gemini, OpenCode) | [subsystems/provider-integration.md](subsystems/provider-integration.md) |
| 4 | Plugin System | Third-party extensions with frontend tabs + optional backend | [subsystems/plugin-system.md](subsystems/plugin-system.md) |
| 5 | MCP Integration | Model Context Protocol tool access | [subsystems/mcp-integration.md](subsystems/mcp-integration.md) |
| 6 | Browser-Use | Automated browser control via MCP | [subsystems/browser-use.md](subsystems/browser-use.md) |
| 7 | Authentication & Security | JWT, API keys, WS auth, tool-permission model | [subsystems/authentication-and-security.md](subsystems/authentication-and-security.md) |
| 8 | Session & Project Management | Session persistence, project CRUD, auto-discovery | [subsystems/session-and-project-management.md](subsystems/session-and-project-management.md) |
| 9 | Database Layer | SQLite, migrations, repositories | [subsystems/database-layer.md](subsystems/database-layer.md) |
| 10 | Notification System | Web push, PWA, in-app, notification preferences | [subsystems/notification-system.md](subsystems/notification-system.md) |
| 11 | Distribution | npm package, Docker sandbox, Electron desktop, PWA | [subsystems/distribution.md](subsystems/distribution.md) |
| 12 | Internationalization & Theming | Ten languages, dark/light themes | [subsystems/internationalization-and-theming.md](subsystems/internationalization-and-theming.md) |

## Document Conventions

- **Business language first.** Each doc starts with what the feature does for the user, not how the code works.
- **Traceability.** Every capability doc ends with a "Technical Mapping" section that lists the server modules and frontend components implementing it.
- **No code blocks for implementation.** Code lives in the source tree. These docs reference it by path.
- **Living documents.** When you change a capability, update the corresponding doc in the same PR.

## Related Documentation

- **`CLAUDE.md`** — Project-level developer guidance, architecture overview, and editing checklist.
- **`docs/architecture/`** — Technical architecture documents (when present).
- **`docs/api/`** — REST and WebSocket API references.
- **`README.md`** — User-facing quick start and feature overview.
