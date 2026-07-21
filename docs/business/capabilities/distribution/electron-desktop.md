# Capability: Electron Desktop

## Description

Native desktop app for macOS and Windows. The Electron app bundles CloudCLI UI with an embedded local Node.js server. Targets: **macOS** (dmg + zip via `electron-builder`) and **Windows** (NSIS installer). App ID: `ai.cloudcli.desktop`, productName: CloudCLI, custom `cloudcli://` URL scheme for deep linking. Source is fully checked into `electron/`.

## Actors

- **macOS/Windows desktop users** — Install the app and use the `cloudcli://` URL scheme.
- **Release engineers** — Build and publish signed distributions.

## Trigger

- A user runs `npm run desktop:dev` (dev mode) or installs the published app (dmg/NSIS).

## Flow (Local Development)

1. The user runs `npm run desktop:dev` with `ELECTRON_DEV_URL=http://127.0.0.1:5173` pointing to the Vite dev server.
2. `electron/main.js` initializes the app, controllers, and window.
3. `electron/localServer.js` optionally spawns a local Node server (or connects to an existing one).
4. `electron/desktopWindow.js` creates the browser window and loads the UI.
5. The user develops and hot-reloads via Vite.

## Flow (Packaged Distribution)

1. The user runs `npm run desktop:dist:mac` or `npm run desktop:dist:win`.
2. The build script stages the app via `desktop:stage` (prepared app bundle in `.desktop-build/desktop-app`).
3. `electron-builder` packages the app as **macOS dmg/zip** or **Windows NSIS installer**.
4. On first launch, `electron/serverInstaller.js` downloads and caches the versioned server bundle to `~/.cloudcli/server/<version>/`.
5. `electron/localServer.js` spawns the local server on a discovered free port (default 3001).
6. `electron/desktopWindow.js` loads the UI from `localhost:<port>`.
7. User interaction is mediated by tabs (`electron/tabs.js`), views (`electron/viewHost.js`), and cloud auth (`electron/cloud.js`).
8. Native desktop notifications are bridged via `electron/desktopNotifications.js` (WebSocket subscription to the server).

## Output

- Native installable app for macOS (dmg/zip) and Windows (NSIS).
- Embedded local server running at `localhost:<port>`.
- Custom URL scheme for resuming sessions and deep linking.
- Native desktop notifications bridged from the server.

## Technical Mapping

**Core files:**
- **electron/main.js** — App bootstrap, lifecycle, IPC event handlers, auth callback protocol.
- **electron/localServer.js** — Spawns the Node.js server, health checks, port discovery.
- **electron/desktopWindow.js** — Creates the browser window, handles navigation, permissions, theme.
- **electron/tabs.js** — Manages tab state (launcher, cloud targets, local targets).
- **electron/viewHost.js** — Uses BrowserView to render content with loading placeholders.
- **electron/desktopNotifications.js** — Subscribes to server notifications via WebSocket and displays them natively.
- **electron/serverInstaller.js** — Downloads versioned server bundles from GitHub releases and caches to `~/.cloudcli/server/`.
- **electron/cloud.js** — Manages cloud auth tokens, OAuth callbacks, encrypted credential storage.
- **electron/preload.cjs** — Context bridge exposing safe IPC APIs to the renderer (origin-gated).
- **electron/launcher/** — Pre-app UI (index.html, launcher.js, launcher.css) for the splash/launcher screen.

**package.json:**
- `desktop` — Run the app (production mode).
- `desktop:dev` — Run with Vite dev server (watches frontend files).
- `desktop:stage` — Prepare the app bundle in `.desktop-build/`.
- `desktop:pack` — Package as portable app (no installer).
- `desktop:dist:mac` — Build macOS dmg + zip.
- `desktop:dist:win` — Build Windows NSIS installer.
- `desktop:icon:mac` — Generate macOS icon set.
- `build` block — `appId: ai.cloudcli.desktop`, `productName: CloudCLI`, mac + win targets.

## Dependencies

- **Distribution** — npm package (server bundle distribution).
- **Local Server** — Node.js runtime, downloaded on first launch from GitHub releases.
- **Database Layer** — `~/.cloudcli/auth.db` persistence in the embedded server.
