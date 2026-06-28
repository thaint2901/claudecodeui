# Capability: Electron Desktop

## Description

Native desktop app target wired into `package.json` (appId: `ai.cloudcli.desktop`, productName: CloudCLI, `cloudcli://` URL scheme, `electron-builder` mac dmg+zip). The `electron/` source directory is NOT checked into this fork; the `npm run desktop*` scripts are kept for the published npm distribution and currently fail locally until the Electron source is added.

## Actors

- **macOS desktop users** — Install the app and use the `cloudcli://` URL scheme.
- **The npm distribution** — Ships the Electron source from a separate location.

## Trigger

- A user runs `npm run desktop:dev` or installs the published dmg.

## Flow (Local — Currently Fails)

1. The user runs `npm run desktop:dev`.
2. The script tries to start from `electron/`, which is not in this fork.
3. The command fails with a missing-directory error.

## Flow (Published Distribution)

1. The user downloads the mac dmg.
2. The dmg contains the Electron app + the `cloudcli` Node binary.
3. The app launches and starts a local server.
4. The user uses the app, and the `cloudcli://` URL scheme routes to specific sessions.

## Output

- A native macOS app.
- A custom URL scheme for deep linking.

## Technical Mapping

- **package.json:** `desktop`, `desktop:dev`, `desktop:pack`, `desktop:dist:mac` scripts; `build` block with `appId: ai.cloudcli.desktop`
- **URL scheme:** `cloudcli://`
- **Source:** `electron/` (not in this fork)

## Dependencies

- **Distribution** — npm package.
