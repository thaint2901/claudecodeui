# Capability: Provider Registry

## Description

The single source of truth for which AI coding CLIs CloudCLI UI supports. Provides `listProviders()` and `resolveProvider()` helpers, an `IProvider` interface that all providers implement, and a `spawnFns` / `abortFns` map wired into the WebSocket hub. Adding a new provider is a one-place registry change.

## Actors

- **Core maintainers** — Register new providers.
- **The chat hub** — Resolves the spawn function for a `chat.send` envelope.
- **The Agent API** — Resolves a provider to dispatch external requests.
- **The frontend** — Lists providers in the picker and the logo bar.

## Trigger

- A new provider is added to the codebase.
- A `chat.send` envelope is received; the hub resolves the provider.
- A `GET /api/providers` request is received.

## Flow (Adding a Provider)

1. Implement a `MyProvider` class extending `AbstractProvider` and the facet interfaces.
2. Add a spawn function in `server/<my-cli>.js`.
3. Register the provider in `server/modules/providers/provider.registry.ts`.
4. Wire the spawn function in the `spawnFns` map in `server/index.js`.
5. Add the provider's logo in `src/components/llm-logo-provider/`.
6. Done — the chat, sidebar, file tree, and Agent API all pick it up.

## Flow (Resolving a Provider at Runtime)

1. A `chat.send` envelope arrives with `provider: 'codex'`.
2. The hub calls `resolveProvider('codex')` → returns the `CodexProvider` instance.
3. The hub looks up `spawnFns['codex']` and dispatches.
4. Events flow back through the chat run registry.

## Output

- A consistent interface for every provider.
- A capability matrix exposed to the frontend.
- A single point of truth for which providers are supported.

## Technical Mapping

- **Registry:** `server/modules/providers/provider.registry.ts`
- **Barrel:** `server/modules/providers/index.ts`
- **Abstract base:** `server/modules/providers/shared/base/abstract.provider.ts`
- **WS hub wiring:** `server/index.js` (`spawnFns`, `abortFns`)
- **REST:** `server/modules/providers/provider.routes.ts`
- **Frontend picker:** `src/components/llm-logo-provider/`

## Dependencies

- **Provider Integration** — All other capabilities in this subsystem.
- **Chat & Agent Streaming** — The hub that uses the registry.
- **Session & Project Management** — Session metadata per provider.
