# Capability: WebSocket Auth

## Description

Validates the user's JWT during the WebSocket upgrade handshake on `/ws`, `/shell`, and `/plugin-ws`. SSE-style clients that can't set headers can use the `?token=` query string instead. In `IS_PLATFORM` mode, JWT validation is bypassed and the first active user is implicitly bound.

## Actors

- **The browser** — Opens the WebSocket.
- **The auth middleware** — Verifies the token at upgrade time.
- **The WebSocket hub** — Attaches the user identity to the connection.

## Trigger

- The browser opens a WebSocket to any WS path.

## Flow (Header)

1. The browser opens `wss://<host>/ws` with `Authorization: Bearer <token>`.
2. The hub validates the JWT during the upgrade.
3. If valid, the connection is accepted; `req.user` is attached.
4. If invalid, the upgrade is rejected.

## Flow (Query)

1. The browser opens `wss://<host>/shell?token=<token>`.
2. The hub reads the token from the query string.
3. The rest is identical to the header flow.

## Flow (Platform Mode)

1. `IS_PLATFORM` is `true` (single-tenant cloud).
2. The hub skips JWT validation.
3. The first active user from `userDb.getFirstUser()` is bound to the connection.

## Output

- An authenticated WebSocket connection with a known user identity.
- (In platform mode) An implicitly bound first user.

## Technical Mapping

- **Backend middleware:** `server/middleware/auth.js` (`authenticateWebSocket`)
- **Backend service:** `server/modules/websocket/services/websocket-auth.service.ts`
- **Backend config:** `server/constants/config.js` (`IS_PLATFORM`)

## Dependencies

- **Authentication & Security** — JWT lifecycle.
- **Database Layer** — `users` table (first-user lookup).
- **Chat & Agent Streaming** — `/ws` uses this auth.
- **Terminal/Shell** — `/shell` uses this auth.
- **Plugin System** — `/plugin-ws` uses this auth.
