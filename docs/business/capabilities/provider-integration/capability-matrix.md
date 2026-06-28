# Capability: Capability Matrix

## Description

Exposes a capability matrix to the frontend that describes what each provider supports: permission modes, image support, abort support, token-usage support, MCP transports, and more. The UI uses this to adapt controls (e.g. hide the image button if the provider doesn't support it).

## Actors

- **End-user developer** — Sees a UI that adapts to provider capabilities.
- **The capabilities service** — Returns the matrix.
- **The frontend** — Reads the matrix and hides/shows controls.

## Trigger

- The frontend mounts a provider-aware component.
- The user switches providers mid-session.

## Flow

1. The frontend calls `GET /api/providers/capabilities` (or per-provider).
2. The capabilities service returns a matrix:
   - `permissionModes: ['default', 'accept-edits', 'plan', 'bypass-permissions']`
   - `supportsImages: true`
   - `supportsAbort: true`
   - `supportsTokenUsage: true`
   - `mcpTransports: ['stdio', 'http', 'sse']`
   - ...
3. The UI uses the matrix to hide/show controls.

## Output

- A consistent, provider-aware UI.
- A documented contract for what each provider supports.

## Technical Mapping

- **Backend service:** `server/modules/providers/services/provider-capabilities.service.ts`
- **Backend interface:** `server/shared/interfaces.ts` (`IProvider`)
- **REST:** `server/modules/providers/provider.routes.ts`
- **Frontend consumer:** `src/components/chat/` (provider-aware controls)

## Dependencies

- **Provider Integration** — All providers expose capabilities.
- **Chat & Agent Streaming** — The UI that consumes the matrix.
