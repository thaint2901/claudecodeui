# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project: CloudCLI UI

A web/desktop UI for **Claude Code**, **Cursor CLI**, **Codex**, and **OpenCode**. Single Vite + React frontend served by an Express backend that spawns CLI agents in PTYs and streams them over WebSocket. The same codebase also targets an Electron desktop build (`electron/` — main.js, localServer.js, desktopWindow.js, tabs.js, viewHost.js, desktopNotifications.js, serverInstaller.js; scripted in `package.json` as `npm run desktop*`, ships macOS dmg/zip + Windows NSIS) and a Docker Sandbox template (`docker/`) — pick the npm route for local dev, the sandbox for hypervisor-level isolation.

Distribution package: `@cloudcli-ai/cloudcli` (published to npm). Repo `name`/`productName` is "CloudCLI" but the GitHub repo and CLI command were historically `claudecodeui` — many file names, README translations, and the `cloudcli` bin all coexist.

**This is a fork** of the upstream `siteboon/claudecodeui`. The fork lives at `thaint-udata/claudecodeui`; same source tree, no local rename.

## Common Commands

Node 22+ is required (`.nvmrc`).

```bash
npm install              # postinstall runs scripts/fix-node-pty.js on macOS
npm run dev              # run server (tsx) + Vite client concurrently
npm run server:dev       # backend only, tsx + ESM, watch mode: server:dev-watch
npm run client           # frontend only, vite dev server

npm run typecheck        # tsc --noEmit on BOTH tsconfig.json and server/tsconfig.json
npm run lint             # eslint src/ server/
npm run lint:fix         # auto-fix
npm run build            # build:client (vite) + build:server (tsc + tsc-alias into dist-server/)
npm run server           # production: node dist-server/server/index.js
npm start                # build then start

# Release (uses release-it + conventional commits; needs GITHUB_TOKEN in .env)
npm run release
```

There is **no test runner wired into the project** (no `npm test`). Existing `.test.js` / `.test.ts` files (e.g. `server/opencode-cli.test.js`, `server/modules/**/tests/`, `server/routes/tests/`) are Vitest-style — run them with `npx vitest run <path>` if needed. Do not assume `npm test` exists; pick the runner that matches the file you're touching.

**Docker sandbox templates** live in `docker/{claude-code,codex}/Dockerfile` and are published as `docker.io/cloudcliai/sandbox:*`. See `docker/README.md` for the `sbx` workflow.

## Architecture Overview

### Repository layout

```
src/                  # React + Vite frontend (TS/TSX + JS/JSX mix)
  components/<feature>/  # feature folders with view/hooks/utils/types/constants
  contexts/              # ThemeContext, AuthContext, WebSocketContext, PluginsContext, etc.
  hooks/                 # cross-feature React hooks (useWebPush, useGitHubStars, ...)
  stores/                # Zustand store(s) (useSessionStore)
  i18n/                  # i18next + react-i18next setup
  lib/, utils/           # browser-side helpers
  main.jsx, App.tsx      # entry + router with auto-detected basename for sub-path deploys

server/                # Express + ws backend (mostly ESM JS, migrating to TS)
  index.js              # bootstrap: env, DB, sessions watcher, single ws server, routes
  claude-sdk.js         # @anthropic-ai/claude-agent-sdk query wrapper (queryClaudeSDK, abort, approvals)
  cursor-cli.js         # Cursor CLI spawn/abort
  openai-codex.js       # Codex SDK query wrapper
  opencode-cli.js       # OpenCode spawn/abort
  voice-proxy.js        # TTS proxy routes
  browser-use-mcp.ts    # Browser-use MCP integration
  routes/               # auth, agent, commands, cursor, git, mcp-utils,
                        # plugins, settings, taskmaster, user
  middleware/auth.js    # JWT, API key, WebSocket auth (validateApiKey/authenticateToken/authenticateWebSocket)
  modules/              # NEW module-per-feature layout (replacing top-level routes):
    browser-use/          # service + REST + MCP routes
    database/             # better-sqlite3 connection, init-db, migrations, schema, repositories
    projects/             # project CRUD REST routes
    providers/            # CLI provider registry (claude/cursor/codex/opencode) — see provider.registry.ts
    websocket/            # central ws hub: chat, shell, plugin proxy, session broadcasts
  services/             # notification-orchestrator, vapid-keys
  utils/                # url-detection, commandParser, gitConfig, plugin-loader,
                        # plugin-process-manager, runtime-paths, colors, mcp-detector
  shared/               # backend-only shared (types, interfaces, utils) — type-only imports
  constants/config.js   # IS_PLATFORM and similar runtime constants
  tsconfig.json         # @/* → server/*  (rootDir: "..", outDir: "../dist-server")

shared/                # TRUE cross-tier shared code (networkHosts.js — host/port helpers used by both Vite and server)

plugins/starter/       # example plugin repo layout

public/                # static assets, sw.js, PWA manifest, screenshots
docker/                # sandbox Dockerfiles (claude-code, codex) + shared scripts
scripts/fix-node-pty.js # postinstall: chmod node-pty spawn-helper on macOS
```

### How a chat message flows

1. React `ChatView` (in `src/components/chat/view/`) sends a message through `WebSocketContext`.
2. The frontend opens a WS to one of the paths proxied in `vite.config.js`: `/ws` (chat), `/shell` (terminal), `/plugin-ws` (plugin RPC). All three resolve to the same server-side `WebSocket` instance created by `server/modules/websocket/index.ts`.
3. The websocket hub dispatches chat messages to the matching provider spawn function — `queryClaudeSDK` (Claude Agent SDK), `spawnCursor`, `queryCodex`, or `spawnOpenCode`. Each streams structured events back to the client.
4. Claude tool approvals are coordinated via `getPendingApprovalsForSession` / `resolveToolApproval` (see `server/claude-sdk.js`) and a permissions UI driven by `src/contexts/PermissionContext.tsx`.

### CLI provider model

`server/modules/providers/provider.registry.ts` is the single source of truth for which CLIs the app supports. To add a new provider:
1. Add a spawn/abort pair in `server/<your-cli>.js`.
2. Register it in `server/modules/providers/provider.registry.ts` and in the `spawnFns` map inside the WS hub config (`server/index.js`).
3. Surface it in the UI under `src/components/llm-logo-provider/`.
4. The `GET /api/providers/:provider/models` endpoint reports the runtime model list (Claude, GPT families per `README.md`).

### Plugin system

Plugins can ship a frontend (tabs) and an optional Node.js backend. Discovery + lifecycle live in `server/utils/plugin-loader.js` and `plugin-process-manager.js`; the websocket hub proxies `/plugin-ws` to the plugin process. The user-facing manager is `src/contexts/PluginsContext.tsx` + `src/components/plugins/`. Plugin install UI lives in Settings → Plugins. There is a starter repo at `plugins/starter/` and a public template at `cloudcli-plugin-starter`.

### Auth & security model

- `server/middleware/auth.js` exports `validateApiKey`, `authenticateToken`, `authenticateWebSocket` — used by REST routes and the WS hub.
- SQLite (`better-sqlite3`) holds users, API keys, sessions, settings. The DB layer has finished migrating to `server/modules/database/` (repositories + migrations) — `server/sessionManager.js` was removed upstream (v1.36.x); session discovery/watching now lives in `server/modules/providers/services/sessions-watcher.service.ts`.
- Claude Code tools are **disabled by default** in the UI — the user must opt in via the gear-icon Tools Settings modal. Do not change that default without coordinating.
- The Vite dev server proxies `/api`, `/ws`, `/shell`, `/plugin-ws` to the backend; `vite.config.js` derives the host from `HOST` and port from `SERVER_PORT`/`PORT` (the `PORT` legacy alias is slated for removal — new code should use `SERVER_PORT` only).

### PWA, i18n, and themes

- Service worker registered in `src/main.jsx`; web-push wired in `server/services/vapid-keys.js` and `notification-orchestrator.js`.
- i18n setup in `src/i18n/config.js`; supported languages mirror the `README.*.md` files (en, ru, de, ko, zh-CN, zh-TW, ja, tr).
- Theme: `src/contexts/ThemeContext.jsx`.

### Desktop & Docker

- Electron: `npm run desktop`/`desktop:dev`/`desktop:dist:mac`/`desktop:dist:win` are wired in `package.json` (`build` block registers `appId: ai.cloudcli.desktop` + the `cloudcli://` URL scheme). The `electron/` source is present as of the v1.36.3 merge — targets should actually run locally now (previously they'd fail with a missing-directory error).
- Docker: each `docker/<agent>/Dockerfile` copies `dist-server`, `dist`, `public`, `shared` into the image and runs `start-cloudcli.sh`.

## Key Conventions

- **ESM everywhere.** Backend source is `.js` ESM. Frontend source is a `.ts/.tsx` + `.js/.jsx` mix (allowed via `allowJs: true`).
- **Two `@/` aliases, one per tier.** Frontend `@/*` → `src/*` (set in `tsconfig.json` and `vite.config.js`); backend `@/*` → `server/*` (set in `server/tsconfig.json`). Don't try to share a single alias config.
- **Backend module boundaries are enforced by ESLint.** `eslint.config.js` uses `eslint-plugin-boundaries` to treat each `server/modules/*` folder as one element. Cross-module imports must go through that module's barrel (`index.ts`/`index.js`) — direct deep imports fail lint. Backend modules may only `import type` from `server/shared/types.ts` or `server/shared/interfaces.ts`; runtime imports of shared utils must come from `server/shared/utils.ts`, `frontmatter.ts`, or `claude-cli-path.ts`. Legacy runtime files still permitted during the migration window: `server/utils/runtime-paths.js`.
- **Frontend folder pattern:** `src/components/<feature>/` typically contains `view/`, `hooks/`, `utils/`, `types/`, `constants/`, plus the entry file (e.g. `mcp/index.ts`, `auth/index.ts`).
- **Manual chunking** is configured in `vite.config.js` for `vendor-react`, `vendor-codemirror`, and `vendor-xterm`. Add new heavy deps there.
- **TypeScript strict mode** is on in both tsconfigs. `tsc-alias` rewrites `@/` aliases after `tsc -p server/tsconfig.json` so the compiled output keeps the alias working.
- **Conventional Commits** are required (commitlint + husky `commit-msg` hook). Lint-staged runs ESLint on staged `.ts/.tsx/.js/.jsx` files (`pre-commit`). Use `feat`, `fix`, `perf`, `refactor`, `docs`, `style`, `chore`, `ci`, `test`, `build`. Scopes are encouraged: `feat(chat): …`. `release-it` reads commit types to bump version and update `CHANGELOG.md`.
- **Husky attribution is OFF** globally (see `.claude/rules/git-workflow.md`).
- **Do not commit secrets.** `.env` is gitignored; `.env.example` documents the real set (`SERVER_PORT`, `HOST`, `DATABASE_PATH`, `VITE_CONTEXT_WINDOW`, `CONTEXT_WINDOW`, optional `CLAUDE_CLI_PATH`).
- **Never hardcode the string `'claude'`** when spawning the CLI from the backend. Always resolve via `resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH)` from `server/shared/claude-cli-path.ts` — it's the only path that honors `CLAUDE_CLI_PATH` and finds `claude.cmd`/`claude.exe` on Windows.
- **Reuse `src/shared/view/ui/{Alert,Button,Confirmation}.tsx`** for banners/inline confirmations instead of one-off styled divs — they carry theme-aware semantic tokens and the same hover/focus/disabled treatment as every other action in the app. See `PermissionRequestsBanner.tsx` for the reference usage.

## Editing Checklist (when working in this repo)

- New CLI provider? Register it in the WS spawn map (`server/index.js`), the provider registry (`server/modules/providers/provider.registry.ts`), the UI logo list, and the model endpoint.
- New plugin API surface? Update both the loader (`server/utils/plugin-loader.js`) and the WS proxy path in the hub.
- Touching `shared/networkHosts.js`? It's used by both Vite (`vite.config.js`) and the server — keep behaviour symmetric.
- Adding a provider's custom-command directory? Add the path to `providerCommandDirs` in `server/utils/command-paths.js` and document the runtime's read path in `docs/business/capabilities/chat-and-agent-streaming/slash-commands.md`. cloudcli lists only what the active runtime can actually dispatch — never add a cross-provider fallback.
- Touching the slash-command flow? cloudcli forwards the slash form (`/cmd args`) to the active session's runtime; the runtime's own dispatcher parses the `.md` file, applies `allowed-tools` / `model` / `$ARGUMENTS` substitution, and dispatches. Do not re-introduce a path that reads/strips the body in cloudcli.

## Gotchas

- **No `npm test` script.** Vitest discovers `**/*.test.{js,ts}` automatically; run a single file with `npx vitest run <path>` and the whole tree with `npx vitest run`. There is no `vitest.config.*` — defaults are in effect.
- **`RUNNING_VERSION` mismatch warning.** `server/index.js` reads its own `package.json#version` once at startup into `RUNNING_VERSION` (line ~86) and exposes it to the frontend. The rebuilt Vite bundle embeds its own build-time version. If the two don't match, the UI shows a "server was updated but not restarted" toast. If you change dependencies or `version`, expect to restart the server even when the new code "looks fine."
- **Service worker is feature-detected.** Registered only when `'serviceWorker' in navigator` (`src/main.jsx`); failures are warned, not thrown. PWA and web-push both rely on `/sw.js` from `public/`.
- **Tools-disabled-by-default** for Claude Code is a security policy, not a bug. Changing the default requires a coordinated UI/UX change in `src/components/settings/`.
- **Worktree bases can lag local main.** The harness creates worktrees off `origin/main`, not local `main`. If a previous session fast-forwarded local `main` past `origin/main` (e.g. `d95c726`), a new worktree branches from the older upstream tip. From outside the worktree, `git log --oneline -1 main` shows the local head; inside the worktree, `git rebase main` picks up local-only commits before you start editing.
- **React TDZ from forward references in `useCallback`.** A `useCallback` defined before the binding it closes over is initialized hits `Cannot access 'X' before initialization` at render time, not at the call site. When adding a new dispatch path that reuses state setters, confirm every closed-over name is declared *above* the hook in the same component. `react-hooks/exhaustive-deps` flags missing deps but not declared-too-late deps — eslint won't catch this for you.
- **Dev server reloads from the main checkout, not the worktree.** Vite + `tsx watch` read the files at `/home/thaint/projects/claudecodeui/...`, not the worktree path. After editing in a worktree, `cp <worktree>/<file> <main>/<file>` to make HMR pick up the change. The `tmp.md` and `.playwright-mcp/` directories in the project root are byproducts of past sessions — ignore them.
- **Browser auth token lives in `localStorage['auth-token']`.** Use it as `Authorization: Bearer <token>` for `curl` against the local dev server. `node:test` against pure helpers (no `@/` imports) is the only test path that runs without alias resolution — `vitest run` is broken in this checkout because there's no vitest config resolving the `@/` alias. **Use `npx tsx --test --tsconfig server/tsconfig.json <path>` instead** — `tsx` resolves the `@/` alias and this runs server `.test.ts` files correctly. Tests that use `mock.module` additionally need `--experimental-test-module-mocks` (Node 24) or they crash with `TypeError: mock.module is not a function`.
- **Port 3001 can serve a stale prebuilt `dist/`.** `npm run dev` runs Vite (5173, live source) and the backend (3001) concurrently; hitting 3001 directly falls back to whatever `dist/` was last built via `npm run build`, which can be weeks stale and silently fake bugs that don't exist in current source. Always browse `localhost:5173` in dev.
- **`npm run dev`'s backend doesn't hot-reload.** `server:dev` (what `npm run dev` uses) is plain `tsx`, not `tsx watch` — edits under `server/**` require killing and restarting the dev server. `server:dev-watch` is the watch variant, not the default.
- **Mint a local JWT for curl/Playwright testing** without a password: read `jwt_secret` from the `app_config` table in `~/.cloudcli/auth.db` (the actual runtime DB — NOT the repo's `./database/auth.db`, which is an unrelated/empty dev artifact) and sign `{userId, username}` with `jsonwebtoken`, matching `generateToken` in `server/middleware/auth.js`.
- **Every new WebSocket `kind` needs an explicit `case` in `useChatRealtimeHandlers.ts`'s switch.** Unhandled kinds fall through to `default`, which force-casts the raw event into `NormalizedMessage` and calls `sessionStore.appendRealtime()` — a non-chat event with no `.id` field corrupts that session's message store and crashes every later merge (`.id.startsWith` on `undefined`).
- **Files replaced via atomic rename (e.g. `~/.claude/daemon/roster.json`) break a direct `chokidar.watch(filePath)`** — the watch silently stops firing after the first rename. Watch the containing directory and filter by filename instead.
- **Commitlint rejects `merge:` as a type.** This repo's conventional-commits config only allows `build, chore, ci, docs, feat, fix, perf, refactor, revert, style, test` — a merge/integration commit needs `chore:` (or another allowed type), not `merge:`.
- **Legacy `git merge-tree <base> <ours> <theirs>` (3 positional args) does not reliably surface real conflicts** — it can report zero `<<<<<<<` markers even when two branches touch overlapping code. Use `git merge-tree --write-tree --messages <base> <ours> <theirs>` (git ≥2.38) instead; it prints explicit `Auto-merging <file>` / `CONFLICT (content): Merge conflict in <file>` lines you can trust before actually merging.
- **Upstream (`siteboon/claudecodeui`) can remove entire features inside an innocuously-named PR.** Gemini CLI support was dropped in commit `4cee5e7` ("Fix/resolve different bugs (#964)") with no mention in the commit title — always diff the actual file list (`git diff --stat <merge-base>..upstream/main`) when pulling upstream changes, don't trust commit subjects alone.
- **`docs/business/**` is hand-authored, not generated.** The project-level `update-docs` skill's recipe (sync from `package.json`/`.env.example`/OpenAPI) doesn't apply here — it's narrative capability docs (Description/Actors/Trigger/Flow/Output/Technical Mapping/Dependencies). Use targeted agents that read the existing sibling doc as a template instead.
- **`gh`'s active account can silently be the wrong fork owner even after "consolidation."** `gh auth status` may show a different account active than the one with write access to the current fork (e.g. an old/dormant fork account stays active in `gh`'s config). Symptom: unexplained 404 on `gh api repos/<owner>/<repo>/... -X PATCH` despite the PR clearly existing. Fix: `gh auth switch --user <correct-account>`, verify with `gh repo view <owner>/<repo> --json viewerPermission`. This is a shared, global `gh` config — a subagent/fork's `gh pr comment`/`gh pr edit` call uses whatever account is active *at the moment it runs*, independent of when the parent session checks or switches it. A comment posted under the wrong account can't be re-attributed afterward (GitHub has no "edit author"), so verify the active account *before* dispatching any subagent that will post to GitHub, not just before your own calls.
- **`gh pr edit --body "..."` can fail with `GraphQL: Projects (classic) is being deprecated... (repository.pullRequest.projectCards)`** even when the edit itself is valid — a `gh` CLI bug unrelated to your input. Workaround: `gh api repos/<owner>/<repo>/pulls/<n> -X PATCH -f body="..."`.
- **Claude Code session-naming internals** (relevant to `server/modules/providers/list/claude/`): the on-disk project-dir name under `~/.claude/projects/` replaces both `/` and `.` with `-`; a session's effective title follows event-*kind* precedence (`custom-title` > `ai-title` > `last-prompt`), not file position — confirmed via the Agent SDK's `getSessionInfo()`. Prefer `renameSession()`/`getSessionInfo()`/`listSessions()` from `@anthropic-ai/claude-agent-sdk` over hand-parsing/writing transcript JSONL. These SDK calls resolve `~/.claude` via `CLAUDE_CONFIG_DIR` (a *named* `homedir` import that ignores a monkey-patched `os.homedir()`) — tests exercising them need both `os.homedir()` patched **and** `process.env.CLAUDE_CONFIG_DIR` set to the same fake dir.
- **Sessions created via the Agent SDK (every claudecodeui-originated session) never appear in Claude Code's interactive `claude --resume` picker, by design** — they're still fully resumable via `claude --resume <session-id>` run from the original project directory.

## Business Documentation

Two-level business doc set in `docs/business/`. Reference it before reasoning about what a feature does or who it serves.

- `overview.md` — one-page executive summary of the product
- `subsystems/*.md` — Level 1: 12 subsystem overviews (chat, terminal, providers, plugins, MCP, browser-use, auth, session, database, notifications, distribution, i18n)
- `capabilities/<subsystem>/*.md` — Level 2: per-capability docs (Description, Actors, Trigger, Flow, Output, Technical Mapping, Dependencies)

When asked to modify or understand a feature, read the relevant `subsystems/<name>.md` first, then drill into `capabilities/<subsystem>/<capability>.md` for the implementation map.

## Project-local Rules

`.claude/rules/` extends the global ECC ruleset with this project's Web (frontend) context: `coding-style.md`, `patterns.md`, `testing.md`, `security.md`, `performance.md`, `code-review.md`, `design-quality.md`, `hooks.md`, `development-workflow.md`, `git-workflow.md`, `agents.md`. The Web ruleset emphasizes semantic HTML, compositor-friendly animation, Core Web Vitals targets (LCP < 2.5s, INP < 200ms, CLS < 0.1), non-template UI, and 80% test coverage. Project-level decisions on which rules supersede the common set are recorded in `.claude/IMPLEMENTATION_NOTES.md`.

## Pointers

- **Where sessions live on disk:** `~/.claude/` (Claude Code) and equivalents for other CLIs. `server/modules/providers/services/sessions-watcher.service.ts` and `modules/projects/` watch this directory to auto-discover sessions for the UI.
- **List of supported models:** runtime, `GET /api/providers/:provider/models`.
- **Public docs:** https://cloudcli.ai/docs
- **Plugin template:** https://github.com/cloudcli-ai/cloudcli-plugin-starter
- **Issue tracker:** https://github.com/siteboon/claudecodeui/issues
- **Discord:** https://discord.gg/buxwujPNRE

## DeepWiki MCP (upstream lookup)

A DeepWiki MCP server is registered in user scope at `https://mcp.deepwiki.com/mcp`. It exposes three tools: `read_wiki_structure`, `read_wiki_contents`, and `ask_question`. All three take a GitHub repo identifier as input.

**When to use it:** for questions about the **upstream** design — `siteboon/claudecodeui` (the original repo this fork is based on). Examples: "how does the websocket hub handle provider failover in upstream?", "what's the upstream's stance on tools being disabled by default?".

**When NOT to use it:**

- This is a **fork** (`thaint-udata/claudecodeui`). DeepWiki only indexes the **public upstream** `siteboon/claudecodeui`. Any local-only changes (this `CLAUDE.md`, `.claude/hooks/hooks.json`, and any uncommitted worktree edits) are **invisible** to DeepWiki.
- For fork-specific behavior, trust this `CLAUDE.md` and the local code over DeepWiki. If DeepWiki contradicts a fact recorded here, the local source wins.
- DeepWiki only covers **public** repos. If the upstream were ever moved private, this MCP would return empty/error responses.

The target repo identifier is always `siteboon/claudecodeui` — pass it as the `repoName` (or equivalent) parameter to each DeepWiki tool call.

## context7 MCP (Claude Code / Agent SDK docs)

Use context7's `query-docs` with library ID **`/websites/code_claude`** (the `https://code.claude.com/docs` mirror) for any question about Claude Code the CLI or `@anthropic-ai/claude-agent-sdk` — the things this app integrates with. It covers CLI flags, `canUseTool`, `AskUserQuestion`, permission modes, `settingSources`, hooks, Agent Teams, sub-agents, and stream-json.

Local source still wins for cloudcli's own behavior (same principle as the DeepWiki block above).
