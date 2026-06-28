# Capability: Platform & Self-Hosted Modes

## Description

Two deployment modes are supported: **self-hosted** (OSS, single-user, JWT-based auth) and **platform** (CloudCLI Cloud, single-tenant, JWT bypass with implicit first-user binding). The mode is selected by the `IS_PLATFORM` env var and affects auth, browser-use, and the Agent API.

## Actors

- **Self-hosters** — Run the app behind a reverse proxy or on a workstation.
- **Cloud operators** — Run the managed CloudCLI Cloud.
- **The auth middleware** — Adjusts behavior based on the mode.
- **The browser-use service** — Adjusts runtime mode.
- **The Agent API** — Adjusts user resolution.

## Trigger

- `IS_PLATFORM` is `true` (platform mode) or `false` / unset (self-hosted mode).
- A request arrives at any auth-gated entry point.

## Flow (Self-Hosted)

1. `IS_PLATFORM` is not set or `false`.
2. The user must register (first-run) or log in.
3. JWTs are required for all REST and WebSocket calls.
4. API keys are per-user (no server-wide lock unless `API_KEY` env is set).

## Flow (Platform)

1. `IS_PLATFORM` is `true`.
2. The first active user is implicitly bound to every request.
3. JWT validation is bypassed.
4. The browser-use service uses the cloud runtime (vs. local Playwright).
5. The Agent API uses the platform default user (unless an API key specifies otherwise).

## Output

- A single auth model that adapts to the deployment mode.
- A consistent UX for both modes (the UI doesn't change).

## Technical Mapping

- **Backend config:** `server/constants/config.js` (`IS_PLATFORM`)
- **Backend middleware:** `server/middleware/auth.js`
- **Backend service:** `server/modules/browser-use/browser-use.service.ts` (runtime mode)
- **Backend route:** `server/routes/agent.js` (default user)

## Dependencies

- **Authentication & Security** — All other capabilities.
- **Database Layer** — User lookup.
- **Distribution** — How the app is deployed.
