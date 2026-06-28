# Capability: API Key Management

## Description

Issues and validates long-lived API keys for external integrations. Two flavors: per-user keys (stored in `api_keys`, validated via `X-API-Key`) and an optional server-wide key (validated via the `API_KEY` env var).

## Actors

- **External integrators** — Use API keys to call `/api/*` from CI / scripts.
- **The auth middleware** — Validates keys on incoming requests.
- **The `api_keys` table** — Stores per-user keys.
- **The `API_KEY` env var** — Optional server-wide lock.

## Trigger

- A user creates an API key in Settings → API keys.
- A request arrives with `X-API-Key` or the server-wide key.

## Flow (Create)

1. The user opens Settings → API keys and clicks **Create**.
2. A 32-byte hex key is generated with the `ck_` prefix.
3. The key is stored in `api_keys` (active, with `last_used = null`).
4. The key is shown to the user once (they must save it; it's not shown again).

## Flow (Validate)

1. A request arrives with `X-API-Key: ck_abc...`.
2. `validateApiKey` looks up the key in `api_keys`.
3. If active, the request is authorized; `last_used` is updated.
4. The user identity is attached to the request.

## Flow (Server-Wide Key)

1. The operator sets `API_KEY=<secret>` in the env.
2. Requests with `X-API-Key: <secret>` (matching the env) are authorized.
3. Per-user key validation is bypassed for these requests.

## Output

- A long-lived API key for external use.
- A `last_used` audit trail.
- A server-wide lock for self-hosted deployments.

## Technical Mapping

- **Backend middleware:** `server/middleware/auth.js` (`validateApiKey`)
- **Backend route:** `server/routes/settings.js`
- **Backend repo:** `server/modules/database/repositories/api-keys.ts`
- **Frontend settings:** `src/components/settings/view/tabs/api-settings/`

## Dependencies

- **Authentication & Security** — User identity (per-user keys).
- **Database Layer** — `api_keys` table.
