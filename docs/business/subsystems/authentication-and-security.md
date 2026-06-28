# Subsystem 7: Authentication & Security

## Business Purpose

The **Authentication & Security** subsystem gates every entry point — REST, WebSocket, and external API key — with a consistent model. It provides single-user registration, JWT issuance with sliding refresh, optional API-key gating, WebSocket upgrade auth, the tool-permission model that gates dangerous agent actions, and the per-user git identity that backs the Git panel.

This is the security backbone: without it, no other subsystem can trust who is calling it.

## Key Capabilities

| Capability | Description |
|------------|-------------|
| **Single-user registration** | Bcrypt-hashed passwords, first-run setup flow |
| **Login** | Username + password → 7-day JWT |
| **JWT issuance** | HS256 signed with a 64-byte secret persisted in `app_config` |
| **Sliding refresh** | When a request arrives past halfway through lifetime, issue a fresh token in `X-Refreshed-Token` |
| **API key auth** | `X-API-Key` header validated against `api_keys` table; bumps `last_used` |
| **Server-wide API key** | `API_KEY` env var gate via `validateApiKey` on REST routes |
| **WebSocket auth** | JWT verified during the upgrade handshake on `/ws`, `/shell`, `/plugin-ws`; `?token=` query fallback |
| **Platform mode** | `IS_PLATFORM` single-tenant deployments skip JWT and bind the first active user |
| **JWT secret bootstrap** | Auto-generated 64-byte hex on first boot, stored in `app_config` |
| **Tool permissions** | Per-provider permission modes (default/plan/accept-edits/bypass-permissions) + per-tool allow/deny rules |
| **Permission UI** | `PermissionContext` + `PermissionRequestsBanner` for inline tool-call approval |
| **Remember choice** | Persist "always allow" rules across sessions |
| **Git identity** | `users.git_name` / `git_email` auto-seeded; editable in Settings; used as committer |
| **Onboarding flow** | First-run wizard: connect agents, set git identity |

## Authentication Methods

| Method | Use Case |
|--------|----------|
| **Username + password (bcrypt)** | Local app login — `POST /api/auth/login` issues 7-day JWT |
| **JWT bearer (Authorization header)** | All REST routes and the WebSocket upgrade |
| **`?token=` query** | SSE-style clients that can't set headers |
| **API key (`X-API-Key`, `ck_`-prefixed)** | External integrations via `/api/agent`; long-lived |
| **Server-wide API key (`API_KEY` env)** | Optional global lock for self-hosted deployments |
| **IS_PLATFORM bypass** | Single-tenant cloud mode — implicit first user |

## Stakeholders

| Stakeholder | What They Get |
|-------------|---------------|
| **End users** | A single account with login, logout, onboarding, and password change. |
| **External integrators** | Long-lived API keys for CI / scripts. |
| **Operators** | Configurable global API-key lock, JWT secret rotation policy. |
| **The LLM agent** | A consistent tool-approval surface and per-tool "remember" rules. |
| **Cloud operators** | `IS_PLATFORM` mode that bypasses JWT for single-tenant deployments. |

## How a Request Is Authenticated

1. The request arrives at a REST route or a WebSocket upgrade.
2. `authenticateToken` (or `authenticateWebSocket`) inspects the `Authorization` header (or `?token=` query for WS upgrade).
3. The JWT is verified against `JWT_SECRET` (loaded from `app_config` at module load).
4. If valid, `userDb.getUserById` resolves the user; `is_active` is checked.
5. If past halfway through lifetime, a fresh token is issued in `X-Refreshed-Token`.
6. `req.user` is attached; downstream handlers see `{ id, username }`.
7. For tool calls in chat, `PermissionContext` is consulted; the user approves/denies inline.

## Cross-Cutting Concerns

- **Tool permissions are a separate gate** — Authentication grants access to the API; tool permissions grant the agent access to the user's machine.
- **JWT secret is process-wide** — Rotated by clearing the `app_config` row; one secret per install.
- **WebSocket auth uses the same JWT** — Verified at upgrade time; no per-message re-auth.
- **Audit** — `api_keys.last_used` is updated on every successful API key validation.
- **Filesystem path validation** — Authenticated handlers still go through `validateWorkspacePath` to prevent traversal.

## Technical Mapping (Entry Points)

- **Middleware:** `server/middleware/auth.js` (exports `validateApiKey`, `authenticateToken`, `authenticateWebSocket`)
- **REST routes:** `server/routes/auth.js`
- **Settings routes:** `server/routes/settings.js`, `server/routes/user.js`
- **Git identity:** `server/utils/gitConfig.js`
- **Frontend context:** `src/contexts/AuthContext.tsx`
- **Frontend login:** `src/components/auth/view/LoginForm.tsx`, `SetupForm.tsx`, `ProtectedRoute.tsx`
- **Frontend permission:** `src/contexts/PermissionContext.tsx`, `src/components/chat/view/subcomponents/PermissionRequestsBanner.tsx`
- **Frontend onboarding:** `src/components/onboarding/view/Onboarding.tsx`

## Capability Documents

- [capabilities/authentication-and-security/registration-and-login.md](capabilities/authentication-and-security/registration-and-login.md)
- [capabilities/authentication-and-security/jwt-lifecycle-and-refresh.md](capabilities/authentication-and-security/jwt-lifecycle-and-refresh.md)
- [capabilities/authentication-and-security/api-key-management.md](capabilities/authentication-and-security/api-key-management.md)
- [capabilities/authentication-and-security/websocket-auth.md](capabilities/authentication-and-security/websocket-auth.md)
- [capabilities/authentication-and-security/tool-permission-model.md](capabilities/authentication-and-security/tool-permission-model.md)
- [capabilities/authentication-and-security/platform-and-self-hosted-modes.md](capabilities/authentication-and-security/platform-and-self-hosted-modes.md)
- [capabilities/authentication-and-security/git-identity-and-onboarding.md](capabilities/authentication-and-security/git-identity-and-onboarding.md)
