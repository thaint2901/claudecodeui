# Capability: Slash Commands

## Description

Exposes a list-and-execute API for user-defined markdown slash commands (with frontmatter) plus provider-aware built-ins like `/models`. The user opens the Command Menu, types a command, and the result is rendered as a message (or a modal, for built-ins).

## Actors

- **End-user developer** — Invokes a slash command from the composer.
- **The command parser** — Reads commands from disk and substitutes placeholders.
- **The command executor** — Runs allowlisted bash or built-in handlers.
- **The CommandMenu** — UI for discovery and invocation.

## Trigger

- The user types `/` in the composer or opens the CommandMenu via hotkey.

## Flow (Built-in `/models`)

1. The user types `/models` and sends.
2. The Commands system detects the built-in name.
3. `executeModelsCommand` calls the provider models service for the active session.
4. The result is rendered as a `CommandResultModal` (a picker) — or, for the active session, the model is changed.

## Flow (User-Defined Command)

1. The user types `/<command-name>`.
2. The Commands system loads the markdown file from disk, parses the frontmatter (description, allowed-tools, etc.), and substitutes `$ARGUMENTS` / `$1`..`$9`.
3. If the command has a `bash:` block, the executor runs it with an allowlist (`echo`, `ls`, `git`, `npm`, etc.) and a timeout.
4. If the command has a `prompt:` block, it is sent to the active provider.
5. The result is rendered in the chat as a message or a modal.

## Output

- A rendered command result (text, picker, or modal).
- For bash commands, the stdout / stderr of the allowlisted command.
- For prompt commands, the model's response.
- Persisted in the session history.

## Technical Mapping

- **Frontend UI:** `src/components/chat/view/subcomponents/CommandMenu.tsx`, `CommandResultModal.tsx`
- **Backend route:** `server/routes/commands.js`
- **Backend parser:** `server/utils/commandParser.js`
- **Backend frontmatter:** `server/shared/frontmatter.ts`
- **Provider models (built-in):** `server/modules/providers/services/provider-models.service.ts`

## Dependencies

- **Chat & Agent Streaming** — The composer and message flow.
- **Provider Integration** — Built-in `/models` uses the model catalog.
- **Authentication & Security** — Authenticated command execution.
