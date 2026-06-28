# Capability: Sidebar Payload & Search

## Description

Returns the sidebar payload (projects with their sessions grouped underneath) in one or paged calls, and supports cross-provider session-message search over Server-Sent Events. Drives the primary navigation of the app.

## Actors

- **End user** — Browses projects, opens sessions, searches messages.
- **The sidebar** — Renders the list.
- **The command palette** — Surfaces search results.
- **The projects-with-sessions service** — Builds the payload.
- **The session-conversations-search service** — Runs the search.

## Trigger

- The sidebar mounts.
- The user types in the sidebar search box.
- The user opens the command palette and types.

## Flow (Payload)

1. The sidebar mounts; the frontend calls `GET /api/projects/with-sessions`.
2. The projects-with-sessions service joins `projects` × `sessions` and returns a nested payload.
3. The sidebar renders the tree.
4. Running sessions are flagged with a live indicator.

## Flow (Search)

1. The user types in the sidebar search box (or opens the command palette).
2. The frontend opens an SSE connection to `/api/sessions/search?q=...`.
3. The search service scans the provider transcripts for matches.
4. Results stream back to the frontend.
5. The sidebar / palette shows the matches.

## Output

- A consistent, fast sidebar.
- A cross-provider search that works across all transcripts.
- Live indicators for running sessions.

## Technical Mapping

- **Backend service:** `server/modules/projects/services/projects-with-sessions-fetch.service.ts`
- **Backend search:** `server/modules/providers/services/session-conversations-search.service.ts`
- **Backend routes:** `server/modules/projects/projects.routes.ts`
- **Frontend sidebar:** `src/components/sidebar/view/Sidebar.tsx`
- **Frontend palette:** `src/components/command-palette/sources/useSessionMessageSearch.ts`

## Dependencies

- **Database Layer** — `projects` and `sessions` tables.
- **Provider Integration** — Per-provider transcript parsing.
- **Session & Project Management** — Project CRUD, session lifecycle.
