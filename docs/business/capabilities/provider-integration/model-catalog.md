# Capability: Model Catalog

## Description

Exposes a live, per-provider model catalog to the UI (and the Agent API). Models are fetched from each provider's API on demand, with a 3-day on-disk cache to avoid hammering the provider. The user picks a model from the picker in the chat composer.

## Actors

- **End-user developer** — Picks a model from the dropdown.
- **The provider models service** — Resolves and caches the catalog.
- **The provider runtime** — Resolves the active model for a session.
- **The Agent API** — Resolves a model for external calls.

## Trigger

- The user opens the model picker in the composer.
- The user resumes a session; the runtime reads the saved model.
- The Agent API receives a request with a model id.

## Flow (Picker)

1. The frontend requests the live model list for the active provider.
2. The provider models service checks the in-memory cache.
3. On miss, it calls the provider's models API (or reads the provider CLI's default model).
4. The result is cached on disk for 3 days.
5. The picker shows the list.
6. The user picks a model; the chat composer emits a `chat.send` with the model id.

## Flow (Resume)

1. A session is resumed; the runtime reads `provider_session_id` and the active model.
2. If the model has been removed from the catalog, the resolver falls back to the provider's default.

## Output

- A live, cached catalog per provider.
- A selected model id on the active session.
- Persisted on the session row.

## Technical Mapping

- **Backend service:** `server/modules/providers/services/provider-models.service.ts`
  - `getProviderModels`
  - `getCurrentActiveModel`
  - `changeActiveModel`
  - `resolveResumeModel`
- **Cache:** 3-day on-disk cache (per provider)
- **REST:** `GET /api/providers/:provider/models`
- **Frontend picker:** `src/components/chat/view/subcomponents/ChatComposer.tsx` (model dropdown)

## Dependencies

- **Provider Integration** — Per-provider model fetch.
- **Chat & Agent Streaming** — Model picker UI.
- **Session & Project Management** — Persisted model on session.
