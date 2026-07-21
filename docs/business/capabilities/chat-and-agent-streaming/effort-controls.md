# Capability: Effort Controls

## Description

Lets users pick a reasoning-effort level for Claude and Codex models on a per-session basis. The effort selector appears in the chat composer next to the model dropdown (when the active provider supports it), allowing users to trade off reasoning depth / latency / cost for a single session — the choice is persisted in localStorage and sent with each message to the provider.

## Actors

- **End-user developer** — Selects an effort level (low, medium, high, etc.) from the composer dropdown.
- **The provider runtime** — Receives the effort value and passes it to the underlying API (e.g. Claude SDK `budgetTokens`, Codex SDK equivalent).
- **The chat WebSocket hub** — Receives the effort in the `chat.send` envelope and forwards it to the provider.
- **The composer UI** — Renders the effort dropdown only for providers that support it (Claude: yes; Cursor: no; Codex: yes; OpenCode: yes).

## Trigger

- The user opens a session with a provider that supports effort (Claude, Codex, OpenCode).
- The user clicks the effort dropdown in the composer and selects a level.

## Flow

1. The user opens a session in a provider that supports effort (Claude, Codex, or OpenCode).
2. The frontend calls `GET /api/providers/:provider/models` to load the model catalog.
3. Each model's definition includes `effort: { default: 'high', values: [...] }` — the available levels for that model.
4. The composer renders an "Effort" selector dropdown (via `useChatProviderState`) only if `provider.supportsEffort === true`.
5. The user picks a level (e.g. "low" for a quick exploratory run).
6. The choice is stored in `localStorage[':provider-effort']` (e.g. `'claude-effort'`, `'codex-effort'`).
7. On the next `chat.send`, the frontend includes `{ effort: 'low', ... }` in the envelope.
8. The server passes the effort value to the provider runtime:
   - Claude: forwarded to `queryClaudeSDK` as `options.budgetTokens`
   - Codex: forwarded to `queryCodex` as `effort`
   - OpenCode: forwarded to `spawnOpenCode` as `effort`
9. The provider runtime applies the effort setting to the model request.
10. The effort level is saved with the session for the next time the user resumes.

## Output

- A dropdown in the composer (visible only for Claude, Codex, OpenCode).
- Persistence of the user's choice per provider across sessions (via localStorage).
- Reduced latency / cost (low effort) or deeper reasoning (high effort) in the provider's response.
- The effort value recorded alongside the session history for audit/transparency.

## Technical Mapping

- **Frontend state:** `src/components/chat/hooks/useChatProviderState.ts` (`providerEfforts`, `setStoredProviderEffort`)
- **Frontend composer:** `src/components/chat/view/subcomponents/ChatComposer.tsx` (renders effort dropdown if `availableEffortOptions.length > 0`)
- **Frontend constants:** `src/components/chat/constants/providerEffort.ts` (default values, fallback options per provider)
- **Backend dispatch:** `server/routes/agent.js` (extracts `effort` from `req.body`, passes to provider spawn)
- **Backend capability matrix:** `server/modules/providers/services/provider-capabilities.service.ts` (`supportsEffort` flag per provider)
- **Model catalog:** `server/modules/providers/list/claude/claude-models.provider.ts`, `server/modules/providers/list/codex/codex-models.provider.ts` (define `effort.values` and `effort.default` per model)
- **Provider integration:** `server/claude-sdk.js`, `server/openai-codex.js`, `server/opencode-cli.js` (apply effort to API/CLI call)

## Dependencies

- **Provider Integration** — Each provider's runtime must accept and apply the effort parameter.
- **Chat & Agent Streaming** — The effort is sent as part of the `chat.send` message envelope.
- **Model Catalog** — The model definition must include the effort options and defaults.
- **Provider Capabilities** — The `supportsEffort` flag gates whether the UI shows the selector.
