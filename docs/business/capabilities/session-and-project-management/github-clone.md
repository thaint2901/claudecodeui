# Capability: GitHub Clone

## Description

Clones a GitHub repository into the local workspace as a new project, with progress streamed over Server-Sent Events. Uses the user's GitHub token (from `user_credentials`) for private repos. The clone URL is sanitized to defend against URL injection.

## Actors

- **End user** — Pastes a GitHub URL in the Project Creation Wizard.
- **The project clone service** — Runs the clone and streams progress.
- **GitHub** — The remote.
- **The `user_credentials` table** — Holds the user's GitHub token.

## Trigger

- The user pastes a GitHub URL in the Project Creation Wizard and submits.

## Flow

1. The user pastes a GitHub URL and clicks **Clone**.
2. The project clone service validates and sanitizes the URL.
3. If the repo is private, the user's GitHub token is used for auth.
4. The service runs `git clone` into the local workspace.
5. Progress is streamed over SSE (stage: cloning, percent, current file, etc.).
6. On completion, a `projects` row is created.
7. The new project appears in the sidebar.

## Output

- A cloned repo on disk.
- A new project in the sidebar.
- Live progress in the wizard.

## Technical Mapping

- **Backend service:** `server/modules/projects/services/project-clone.service.ts`
- **Backend repo:** `server/modules/database/repositories/credentials.ts` (github_tokens)
- **Backend route:** `server/modules/projects/projects.routes.ts` (startCloneProject)
- **Frontend wizard:** `src/components/project-creation-wizard/components/StepReview.tsx`

## Dependencies

- **Session & Project Management** — Project CRUD.
- **Authentication & Security** — User identity.
- **Database Layer** — `user_credentials` table.
