# Capability: JWT Lifecycle & Refresh

## Description

Issues HS256-signed JWTs with a 7-day lifetime. The signing secret is generated on first boot (64-byte hex) and stored in `app_config`. When a request arrives past the halfway point of the token lifetime, a fresh token is issued in the `X-Refreshed-Token` response header — transparent to the client.

## Actors

- **The auth middleware** — Issues and verifies tokens.
- **`app_config` table** — Holds the JWT secret.
- **The frontend** — Stores the token and replaces it on `X-Refreshed-Token`.

## Trigger

- A user logs in or registers.
- A request arrives past halfway through the token's lifetime.

## Flow (Issue)

1. The user logs in.
2. The auth service signs `{ userId, username }` with HS256 and the JWT secret.
3. The token has `expiresIn: '7d'`.
4. The token is returned in the response body.

## Flow (Verify)

1. The request arrives with `Authorization: Bearer <token>`.
2. The auth middleware verifies the token against the JWT secret.
3. The user is resolved from `userId`.
4. `is_active` is checked.

## Flow (Refresh)

1. The token is past halfway through its lifetime.
2. The auth middleware signs a new token with the same payload.
3. The new token is returned in `X-Refreshed-Token`.
4. The frontend replaces its stored token.

## Output

- A 7-day JWT.
- A transparent refresh on every request past halfway.
- A single JWT secret per install (no rotation policy in MVP).

## Technical Mapping

- **Backend middleware:** `server/middleware/auth.js`
- **Backend route:** `server/routes/auth.js`
- **Backend repo:** `server/modules/database/repositories/app-config.ts` (`getOrCreateJwtSecret`)
- **Frontend context:** `src/contexts/AuthContext.tsx` (token replacement)

## Dependencies

- **Database Layer** — `app_config` table.
- **Authentication & Security** — Registration & login.
