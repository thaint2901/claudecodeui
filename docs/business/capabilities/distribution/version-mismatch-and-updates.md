# Capability: Version Mismatch & Updates

## Description

Detects when the running server is newer than the built UI bundle and prompts the user to refresh / restart. Exposes a system update endpoint that runs `git pull` or `npm install -g` based on install mode.

## Actors

- **The server** — Snapshots `RUNNING_VERSION` at boot.
- **The frontend** — Embeds its build-time version.
- **The end user** — Sees the upgrade modal.
- **The operator** — Runs the system update endpoint.

## Trigger

- The frontend's build-time version doesn't match the server's `RUNNING_VERSION`.
- An operator calls `POST /api/system/update`.

## Flow (Mismatch Detection)

1. The server reads `package.json#version` into `RUNNING_VERSION` at boot.
2. The frontend embeds its own build-time version.
3. The frontend calls `/api/system/version` (or reads a global).
4. If the versions don't match, the UI shows the "server was updated but not restarted" modal.
5. The user reloads the page to pick up the new bundle.

## Flow (Update)

1. The operator calls `POST /api/system/update`.
2. The server detects the install mode (npm vs. git clone).
3. For npm: runs `npm install -g @cloudcli-ai/cloudcli@latest`.
4. For git: runs `git pull` and rebuilds.
5. The operator restarts the server.

## Output

- A clear UX when versions are out of sync.
- A one-call update for operators.

## Technical Mapping

- **Backend:** `server/index.js` (`RUNNING_VERSION`, `/api/system/update`)
- **Frontend modal:** `src/components/version-upgrade/view/VersionUpgradeModal.tsx`

## Dependencies

- **Distribution** — All channels.
