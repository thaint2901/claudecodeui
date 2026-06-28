# Capability: Workspace Path Validation

## Description

Validates that every project path is inside the allowed `WORKSPACES_ROOT` and rejects path traversal (`..`, symlinks outside the root, etc.). Used by every handler that touches the filesystem on behalf of the user.

## Actors

- **All filesystem-touching handlers** — The only consumers.
- **`validateWorkspacePath`** — The validator function.
- **`WORKSPACES_ROOT`** — The allowed root directory.

## Trigger

- Any handler receives a project path from a user (REST body, query, or WebSocket envelope).

## Flow

1. The handler receives a project path.
2. `validateWorkspacePath` resolves the path (handling `..`, symlinks, etc.).
3. The resolved path is checked against `WORKSPACES_ROOT`.
4. If outside, an `AppError` is thrown with a 400 status.
5. If inside, the resolved path is used.

## Output

- A path-traversal-safe filesystem operation.
- A consistent 400 error for invalid paths.

## Technical Mapping

- **Validator:** `server/shared/utils.ts` (`validateWorkspacePath`, `normalizeProjectPath`)
- **Used by:** `server/modules/projects/`, `server/index.js` (file ops, file tree), `server/modules/websocket/`

## Dependencies

- **Database Layer** — All other capabilities.
- **Authentication & Security** — Path validation is part of the defense-in-depth model.
