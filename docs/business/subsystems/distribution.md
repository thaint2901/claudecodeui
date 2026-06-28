# Subsystem 11: Distribution

## Business Purpose

The **Distribution** subsystem packages and ships CloudCLI UI to four kinds of users:

1. **Self-hosters** who `npm install -g @cloudcli-ai/cloudcli`
2. **Docker Sandbox users** who run a prebuilt `cloudcliai/sandbox:*` image
3. **Desktop users** who install the Electron app (macOS dmg/zip)
4. **PWA users** who install the web app to their home screen

The same Vite + Express + ws bundle powers all four targets. Distribution is the surface that turns the codebase into a product.

## Channels

| Channel | Package | Audience | Status |
|---------|---------|----------|--------|
| **npm** | `@cloudcli-ai/cloudcli` (v1.34.0) | Self-hosting developers | Primary |
| **Docker** | `docker.io/cloudcliai/sandbox:claude-code\|codex\|gemini` | Sandbox / microVM users | Published |
| **Electron** | `ai.cloudcli.desktop` (`cloudcli://` URL scheme) | macOS desktop users | Wired (source not in fork) |
| **PWA** | `public/manifest.json` + `public/sw.js` | Mobile / installable web users | Active |
| **Cloud** | `https://cloudcli.ai` | No-setup users | External (code not in repo) |
| **Legacy redirect** | `@siteboon/claude-code-ui` | Old package name | Thin shim |

## Key Capabilities (npm)

| Capability | Description |
|------------|-------------|
| **Primary package** | `@cloudcli-ai/cloudcli` (v1.34.0) — installs the full Express+React app |
| **`cloudcli` binary** | Runs the server from `dist-server/` |
| **prepublishOnly** | Runs the build (`build:client` + `build:server`) before publish |
| **Legacy redirect** | `@siteboon/claude-code-ui` re-exports the new package for old users |
| **`fix-node-pty.js`** | postinstall: chmod `node-pty` spawn-helper on macOS |
| **Release** | `npm run release` uses `release-it` + conventional commits; needs `GITHUB_TOKEN` |

## Key Capabilities (Docker)

| Capability | Description |
|------------|-------------|
| **Sandbox templates** | `docker/claude-code/Dockerfile`, `docker/codex/Dockerfile`, `docker/gemini/Dockerfile` |
| **Shared scripts** | `docker/shared/install-cloudcli.sh` (npm install -g), `start-cloudcli.sh` (autostart on shell open) |
| **Base image** | `FROM docker/sandbox-templates:<agent>` (official Docker Sandbox base) |
| **Auto-start** | `.bashrc` sources `/home/agent/.cloudcli-start.sh` so the server comes up on shell open |
| **Defaults** | `SERVER_PORT=3001`, `HOST=0.0.0.0`, `DATABASE_PATH=~/.cloudcli/auth.db` |
| **`sbx` workflow** | See `docker/README.md` for the `sbx` CLI usage |

## Key Capabilities (Electron)

| Capability | Description |
|------------|-------------|
| **App ID** | `ai.cloudcli.desktop` |
| **Product name** | CloudCLI |
| **URL scheme** | `cloudcli://` |
| **macOS targets** | dmg + zip via `electron-builder` |
| **npm scripts** | `desktop`, `desktop:dev`, `desktop:pack`, `desktop:dist:mac` |
| **Status** | Source directory not in this fork; kept for the published distribution |

## Key Capabilities (PWA)

| Capability | Description |
|------------|-------------|
| **Manifest** | `public/manifest.json` — name, short_name=CloudCLI UI, start_url=/, display=standalone, scope=/, theme_color=#ffffff, orientation=portrait-primary |
| **Icons** | 8 maskable icons (72×72 to 512×512) in `public/icons/` |
| **iOS meta** | `apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style`, `apple-mobile-web-app-title`, 152/192 apple-touch-icons |
| **Service worker** | `public/sw.js` registered on `window.load` and in `src/main.jsx` with `'serviceWorker' in navigator` check |
| **Offline** | Partial — only `manifest.json` precached; HTML is network-first; hashed `/assets/*` are cache-first; `/api` and `/ws` are never intercepted |
| **Web-push** | Full pipeline via `notification-orchestrator.js` and the service worker |

## Deployment Model

### Self-Hosted

```bash
npm install -g @cloudcli-ai/cloudcli
cloudcli start --port 3001
```

The npm package ships:
- `dist/` — Vite client bundle
- `dist-server/` — compiled Express server with the `cloudcli` CLI entry
- `shared/`
- `public/api-docs.html`
- `scripts/fix-node-pty.js` (postinstall)

The server listens on `$SERVER_PORT` (default 3001, `$HOST` default 0.0.0.0) and persists state in `~/.cloudcli/auth.db`.

### Docker Sandbox

The Docker images are the same Node process, installed via `npm install -g @cloudcli-ai/cloudcli` and started by `.bashrc` on shell open.

### Cloud (External)

`https://cloudcli.ai` is a fully managed hosted option ("no setup required"). Code is not in this repo.

## Stakeholders

| Stakeholder | What They Get |
|-------------|---------------|
| **Self-hosters** | A single npm install and a binary to run. |
| **Docker users** | A prebuilt image with the agent of their choice. |
| **Desktop users** | A native macOS app with a custom URL scheme. |
| **Mobile users** | An installable PWA. |
| **Operators** | A consistent env-var contract (`SERVER_PORT`, `HOST`, `DATABASE_PATH`). |
| **Release engineers** | Conventional-commits-driven releases via `release-it`. |

## Cross-Cutting Concerns

- **Version mismatch detection** — `RUNNING_VERSION` is snapshotted at boot; the rebuilt Vite bundle embeds its own build-time version; if they differ, the UI shows a "server was updated but not restarted" toast.
- **SPA fallback** — No-cache HTML; 1-year cache on hashed assets.
- **Postinstall** — `fix-node-pty.js` chmods the spawn helper on macOS.
- **Deprecation** — `PORT` legacy alias is slated for removal; new code uses `SERVER_PORT`.
- **System update** — `POST /api/system/update` runs `git pull` or `npm install -g` based on install mode.

## Technical Mapping (Entry Points)

- **package.json:** `/home/thaint/projects/claudecodeui/package.json`
- **npm scripts:** `npm run build`, `npm start`, `npm run dev`, `npm run release`, `npm run desktop*`
- **Release script:** `release.sh`
- **Redirect package:** `redirect-package/`
- **Docker templates:** `docker/`
- **Docker shared scripts:** `docker/shared/`
- **PWA manifest:** `public/manifest.json`
- **PWA service worker:** `public/sw.js`
- **PWA icons:** `public/icons/`
- **Version mismatch:** `server/index.js` (RUNNING_VERSION), `src/components/version-upgrade/view/VersionUpgradeModal.tsx`

## Capability Documents

- [capabilities/distribution/npm-package.md](capabilities/distribution/npm-package.md)
- [capabilities/distribution/docker-sandbox.md](capabilities/distribution/docker-sandbox.md)
- [capabilities/distribution/electron-desktop.md](capabilities/distribution/electron-desktop.md)
- [capabilities/distribution/pwa.md](capabilities/distribution/pwa.md)
- [capabilities/distribution/version-mismatch-and-updates.md](capabilities/distribution/version-mismatch-and-updates.md)
