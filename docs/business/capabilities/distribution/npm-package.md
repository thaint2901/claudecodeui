# Capability: npm Package

## Description

Primary distribution channel. CloudCLI UI is published to npm as `@cloudcli-ai/cloudcli` (v1.34.0). The package installs the full Express+React app, runs `prepublishOnly` to build, and ships a `cloudcli` binary that runs the server from `dist-server/`.

## Actors

- **Self-hosting developers** — `npm install -g @cloudcli-ai/cloudcli` and run `cloudcli`.
- **CI / automation** — Pin a version and use as a base.
- **Release engineers** — Run `npm run release` (release-it + conventional commits).

## Trigger

- A user installs the package.
- A maintainer runs `npm run release`.

## Flow (Install)

1. The user runs `npm install -g @cloudcli-ai/cloudcli`.
2. The postinstall script (`scripts/fix-node-pty.js`) chmods the `node-pty` spawn helper on macOS.
3. The package installs to the global `node_modules`.
4. The `cloudcli` binary is on the PATH.

## Flow (Run)

1. The user runs `cloudcli` (or `cloudcli start --port 3001`).
2. The server starts and listens on `$SERVER_PORT` (default 3001).
3. The user opens `http://localhost:3001` in a browser.
4. State is persisted in `~/.cloudcli/auth.db`.

## Flow (Release)

1. The maintainer runs `npm run release`.
2. `release-it` reads conventional commits, bumps the version, and updates `CHANGELOG.md`.
3. The maintainer confirms and pushes the tag.
4. CI publishes to npm.

## Output

- A globally installed package with a working binary.
- A versioned, conventional-commits-driven release.
- A persisted `~/.cloudcli/auth.db` per install.

## Technical Mapping

- **package.json:** `/home/thaint/projects/claudecodeui/package.json`
- **Release script:** `release.sh`
- **Postinstall:** `scripts/fix-node-pty.js`
- **Legacy redirect:** `redirect-package/` (`@siteboon/claude-code-ui` shim)
- **Build:** `npm run build` (vite + tsc + tsc-alias into `dist-server/`)
- **Run:** `npm start` or `cloudcli`

## Dependencies

- **Distribution** — All other channels.
- **Database Layer** — `~/.cloudcli/auth.db` persistence.
