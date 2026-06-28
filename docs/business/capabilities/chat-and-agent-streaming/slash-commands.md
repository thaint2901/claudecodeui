# Capability: Slash Commands

## Description

Exposes a list-and-execute API for user-defined markdown slash commands (with frontmatter) plus provider-aware built-ins like `/models`. The user opens the Command Menu, types a command, and the result is rendered as a message (or a modal, for built-ins).

Each provider's command set is surfaced independently: a Claude session shows commands from `~/.claude/commands/` and `<project>/.claude/commands/`; an OpenCode session shows commands from `~/.config/opencode/commands/` and `<project>/.opencode/commands/`. The runtime's own command dispatcher (Claude Agent SDK or the `opencode run` CLI) reads the file and applies `allowed-tools` / `model` / `$ARGUMENTS` substitution, so cloudcli never strips the body and never silently drops `allowed-tools`.

## Actors

- **End-user developer** — Invokes a slash command from the composer.
- **The CommandMenu** — UI for discovery and invocation, sourced from the active session's provider.
- **The command list service** — Scans the active provider's native command directory; parses frontmatter with a tolerant fallback so a malformed YAML block (e.g. `argument-hint: [x] (y)`) still lists the command.
- **The active session's runtime** — Reads the `.md` file itself, applies `allowed-tools` / `model` / `$ARGUMENTS` substitution, and dispatches the command. cloudcli just forwards the slash form.
- **Built-in handlers** — `/models`, `/cost`, `/memory`, `/config`, `/status`, `/help` resolved by name on the server.

## Trigger

- The user types `/` in the composer or opens the CommandMenu via hotkey.

## Flow (Built-in `/models`)

1. The user types `/models` and sends.
2. The Commands system detects the built-in name.
3. `executeModelsCommand` calls the provider models service for the active session.
4. The result is rendered as a `CommandResultModal` (a picker) — or, for the active session, the model is changed.

## Flow (User-Defined Command)

1. The user types `/<command-name> [args…]`.
2. The frontend posts to `/api/commands/list` (passing the active `provider`) to populate the palette, and to `/api/commands/execute` to invoke.
3. The list path scans the active provider's native command directory and tries to parse each file's frontmatter. On any YAML error it logs a warning and falls back to a heading-derived description so the command is still surfaced.
4. The execute path validates the file lives inside the active provider's command directory, then returns `{ injectAsPrompt: "/<command-name> <args>" }` — without reading or re-parsing the body.
5. The frontend sets `injectAsPrompt` into the composer and re-submits. The message is delivered to the active session's runtime (Claude Agent SDK or `opencode run`).
6. The runtime's own command dispatcher reads the `.md` file, applies `allowed-tools` / `model` / `$ARGUMENTS` substitution, and dispatches.
7. The result is rendered in the chat as a normal assistant turn.

## Per-Provider Command Directories

| Provider | User-level | Project-level |
|---|---|---|
| Claude | `~/.claude/commands/` | `<project>/.claude/commands/` |
| OpenCode | `~/.config/opencode/commands/` | `<project>/.opencode/commands/` |
| Others (Cursor, Codex, Gemini) | Fall back to Claude's layout | Fall back to Claude's layout |

These match what each runtime actually reads. OpenCode's compatibility layer inherits `CLAUDE.md` and `~/.claude/skills/` from Claude Code but **not** `.claude/commands/`, so the palette is scoped to the directory each runtime will dispatch from.

## Tolerant Frontmatter

Frontmatter is a hint for the palette (description, allowed-tools, model, argument-hint). A malformed block must never break a command — the runtime's parser will read the file itself regardless. When `parseFrontMatter` throws (e.g. unquoted bracket-then-paren values, YAML 1.1 quirks), cloudcli:

1. Logs a warning naming the file and the parser error.
2. Strips the frontmatter with a tiny line-based fallback (`stripFrontMatter` in `server/utils/command-paths.js`).
3. Derives a description from the first `# Heading` line in the body (or empty).
4. Continues with `metadata: {}` — the runtime still reads the file and applies its own parsing.

## Output

- A rendered command result (text, picker, or modal).
- Built-in commands render as `CommandResultModal` pickers (e.g. `/models`, `/cost`).
- User-defined commands render in the chat as a normal assistant turn, because the runtime's dispatcher produces the response.
- Persisted in the session history as any other message.

## Technical Mapping

- **Frontend UI:** `src/components/chat/view/subcomponents/CommandMenu.tsx`, `CommandResultModal.tsx`
- **Frontend hooks:** `src/components/chat/hooks/useSlashCommands.ts` (passes active `provider` into `/api/commands/list`), `useChatComposerState.ts` (`handleCustomCommand` sets `injectAsPrompt` into the composer and re-submits)
- **Backend route:** `server/routes/commands.js` (`/list` branches by provider; `/execute` no longer parses the body, returns `injectAsPrompt`)
- **Backend pure helpers:** `server/utils/command-paths.js` (`stripFrontMatter`, `providerCommandDirs`) — no `@/` imports so the helpers are unit-testable
- **Backend frontmatter:** `server/shared/frontmatter.ts` (still used by the list path; tolerant catch wraps the call)
- **Provider models (built-in):** `server/modules/providers/services/provider-models.service.ts`

## Dependencies

- **Chat & Agent Streaming** — The composer and message flow.
- **Provider Integration** — Each runtime reads its own native command directory.
- **Authentication & Security** — Authenticated command execution; path validation against the active provider's directory.
