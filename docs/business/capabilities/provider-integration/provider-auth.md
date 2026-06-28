# Capability: Provider Auth

## Description

Manages per-provider authentication status and login flows. Each provider has its own auth method: Claude uses the SDK's login, Cursor uses `cursor-agent login`, Codex uses the SDK, Gemini uses env vars or `~/.gemini/.env`, OpenCode uses its own flow. The UI surfaces the auth status and walks the user through the login if needed.

## Actors

- **End-user developer** — Initiates a login from the provider picker.
- **The provider auth service** — Resolves status and starts the flow.
- **The terminal** — Shows the CLI auth prompts (Claude login, etc.).
- **The provider credentials** — Stored in `user_credentials`.

## Trigger

- The user opens the provider picker and the provider is not authenticated.
- The user clicks **Login** for a provider in Settings → Agents.

## Flow

1. The frontend calls `GET /api/providers/:provider/auth-status`.
2. The provider auth service checks if the provider is installed and authenticated.
3. If not, the UI shows a **Login** button.
4. The user clicks **Login**; the service starts the provider's login flow.
5. The terminal/PTY shows the auth URL; the user completes the flow in their browser.
6. The service detects success and updates the auth status.
7. The provider's credentials are written to `user_credentials` (if applicable).

## Output

- A per-provider auth status.
- A completed login.
- Credentials stored for the next session.

## Technical Mapping

- **Backend service:** `server/modules/providers/services/provider-auth.service.ts`
  - `getProviderAuthStatus`
  - `isProviderInstalled`
- **Backend interface:** `server/shared/interfaces.ts` (`IProviderAuth`)
- **REST:** `server/modules/providers/provider.routes.ts`
- **Frontend UI:** `src/components/provider-auth/view/ProviderLoginModal.tsx`
- **Settings tab:** `src/components/settings/view/tabs/agents-settings/AgentsSettingsTab.tsx`
- **Credentials:** `server/modules/database/repositories/credentials.ts`

## Dependencies

- **Provider Integration** — Per-provider login flow.
- **Terminal/Shell** — Used for the CLI auth prompts.
- **Authentication & Security** — User identity.
- **Database Layer** — `user_credentials` table.
