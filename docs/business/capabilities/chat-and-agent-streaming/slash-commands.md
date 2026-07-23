# Capability: Slash Commands

## Description

Exposes a list-and-execute API for user-defined markdown slash commands (with frontmatter) plus provider-aware built-ins like `/models`. The user opens the Command Menu and picks a command; picking one **inserts** it into the composer rather than dispatching it immediately, so the user can type arguments before sending. Sending happens on Enter like any other message.

Each provider's command set is surfaced independently: a Claude session shows commands from `~/.claude/commands/` and `<project>/.claude/commands/`; an OpenCode session shows commands from `~/.config/opencode/commands/` and `<project>/.opencode/commands/`. The runtime's own command dispatcher (Claude Agent SDK or the `opencode run` CLI) reads the file and applies `allowed-tools` / `model` / `$ARGUMENTS` substitution, so cloudcli never strips the body and never silently drops `allowed-tools`.

For Claude sessions, the palette also lists Claude Code's own interactive built-ins (`/clear`, `/compact`, `/review`, …) sourced live from the CLI itself, and two ccui-implemented commands, `/fork` and `/subtask`, that cloudcli intercepts before the message ever reaches the runtime.

## Actors

- **End-user developer** — Invokes a slash command from the composer.
- **The CommandMenu** — UI for discovery and selection, sourced from the active session's provider, grouped into four buckets (see "Palette Grouping" below).
- **The command list service** — Scans the active provider's native command directory; parses frontmatter with a tolerant fallback so a malformed YAML block (e.g. `argument-hint: [x] (y)`) still lists the command.
- **The active session's runtime** — Reads the `.md` file itself, applies `allowed-tools` / `model` / `$ARGUMENTS` substitution, and dispatches the command. cloudcli just forwards the slash form (except `/fork` and `/subtask`, which cloudcli intercepts itself — see "Fork & Subtask" below).
- **Built-in handlers** — `/models`, `/cost`, `/memory`, `/config`, `/status`, `/help` resolved by name on the server (the "ccui commands" group).
- **The WebSocket chat hub** — Intercepts `/fork` and `/subtask` at `chat.send` time, before dispatching to the provider's spawn function.

## Trigger

- The user types `/` in the composer or opens the CommandMenu via hotkey.

## Flow (Built-in `/models`)

1. The user types `/models` and sends.
2. The Commands system detects the built-in name.
3. `executeModelsCommand` calls the provider models service for the active session.
4. The result is rendered as a `CommandResultModal` (a picker) — or, for the active session, the model is changed.

## Flow (User-Defined Command)

1. The user types `/` (or opens the CommandMenu) and picks a command from the palette; the command name is **inserted into the composer text** (`insertCommandIntoInput`), not dispatched — the user can now type arguments before sending.
2. While the composer's leading token exactly matches a known command name, `ChatComposer` overlays an indigo highlight on it (`matchLeadingCommand` in `src/components/chat/utils/commandToken.ts`); an unrecognized `/word` is left unstyled so the highlight never implies a command that won't actually dispatch.
3. The user sends. The frontend posts to `/api/commands/list` (passing the active `provider`) to populate the palette (already done on mount/provider-change), and to `/api/commands/execute` to invoke.
4. The list path scans the active provider's native command directory and tries to parse each file's frontmatter. On any YAML error it logs a warning and falls back to a heading-derived description so the command is still surfaced.
5. The execute path validates the file lives inside the active provider's command directory, then returns `{ injectAsPrompt: "/<command-name> <args>" }` — without reading or re-parsing the body.
6. The frontend sets `injectAsPrompt` into the composer and re-submits. The message is delivered to the active session's runtime (Claude Agent SDK or `opencode run`).
7. The runtime's own command dispatcher reads the `.md` file, applies `allowed-tools` / `model` / `$ARGUMENTS` substitution, and dispatches.
8. The result is rendered in the chat as a normal assistant turn.

## Palette Grouping

`CommandMenu.tsx` groups the palette into four namespaces, in this display order: **ccui commands** (the 6 pseudo-commands above — relabeled "CloudCLI Commands" in the UI, was "builtin"), **Claude Code built-in**, **project** (scope-derived: custom `.md` commands plus skills whose `scope` is `project`), and **user** (custom `.md` commands plus `scope: user` skills). Skills are no longer a separate bucket — `useSlashCommands.ts` merges each skill into the project or user group based on its own `scope` field.

The Claude Code built-in group is sourced dynamically, not hardcoded: every Claude session's `system/init` message reports the CLI's actual `slash_commands` list, which `setClaudeBuiltinCommands` caches process-wide in `server/utils/claude-builtin-commands.js` (self-healing across a CLI upgrade — no server restart needed once a new session starts). `useSlashCommands.ts` computes the group "by subtraction": a name is included only if no richer source (a ccui pseudo-command, a skill, or a custom `.md` command) already claims it, and any name containing `:` is dropped as plugin-namespaced (definitionally not a bare built-in). Because the cache starts empty, this group is empty until the first Claude session of the server process reports its `system/init` message.

## Fork & Subtask

`/fork` and `/subtask` are Claude Code commands that cloudcli itself intercepts at the WebSocket layer (`handleChatSend` in `server/modules/websocket/services/chat-websocket.service.ts`), before the message reaches the SDK as a normal turn:

- **`/fork` (optionally `/fork <prompt>`)** — Branches the conversation into a brand-new app session. cloudcli allocates a new session row named "`<parent> (fork)`", resumes the parent's provider-native session id with `forkSession: true`, and starts the fork on the given prompt (or a default "continue" prompt if none was given). An acknowledgment is written into the *original* session's transcript telling the user where the fork went; failures surface as a `task_notification`.
- **`/subtask <task>`** — Rewrites the prompt (`buildSubtaskPrompt`) into an explicit instruction telling the model to use the Agent tool with `subagent_type: "fork"` to work the task in the background and report back. This is best-effort — there is no SDK API that forces tool selection, so the model usually complies but may act directly instead. The run is scoped with `CLAUDE_CODE_FORK_SUBAGENT=1` and `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` (set only on this run's environment in `server/claude-sdk.js`, not process-wide).

Both are always offered in the Claude Code built-in group once the cache is non-empty (`ALWAYS_INCLUDED_NAMES` in `claude-builtin-commands.js`), even though the CLI's own `slash_commands` list never reports them (they're interactive-only in the raw CLI).

## Per-Provider Command Directories

| Provider | User-level | Project-level |
|---|---|---|
| Claude | `~/.claude/commands/` | `<project>/.claude/commands/` |
| OpenCode | `~/.config/opencode/commands/` | `<project>/.opencode/commands/` |
| Others (Cursor, Codex) | Fall back to Claude's layout | Fall back to Claude's layout |

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

- **Frontend UI:** `src/components/chat/view/subcomponents/CommandMenu.tsx` (four-group palette rendering), `CommandResultModal.tsx`
- **Frontend composer:** `src/components/chat/view/subcomponents/ChatComposer.tsx` (renders the leading-command highlight), `src/components/chat/utils/commandToken.ts` (`matchLeadingCommand`)
- **Frontend hooks:** `src/components/chat/hooks/useSlashCommands.ts` (passes active `provider` into `/api/commands/list`, computes the claude-builtin group by subtraction, merges skills into project/user by `scope`, inserts the picked command via `insertCommandIntoInput` rather than dispatching), `useChatComposerState.ts` (`handleCustomCommand` sets `injectAsPrompt` into the composer and re-submits)
- **Backend route:** `server/routes/commands.js` (`/list` branches by provider and returns `claudeBuiltIn`; `/execute` no longer parses the body, returns `injectAsPrompt`)
- **Backend built-in cache:** `server/utils/claude-builtin-commands.js` (`setClaudeBuiltinCommands`, `getClaudeBuiltinCommandEntries`; process-wide cache seeded from `system/init`)
- **Backend pure helpers:** `server/utils/command-paths.js` (`stripFrontMatter`, `providerCommandDirs`) — no `@/` imports so the helpers are unit-testable
- **Backend frontmatter:** `server/shared/frontmatter.ts` (still used by the list path; tolerant catch wraps the call)
- **Backend fork/subtask interception:** `server/modules/websocket/services/chat-websocket.service.ts` (`parseForkCommand`, `parseSubtaskCommand`, `buildSubtaskPrompt`, `handleChatSend`)
- **Backend fork/subtask env scoping:** `server/claude-sdk.js` (`forkSubagent` option sets `CLAUDE_CODE_FORK_SUBAGENT` / `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` on the run's own `sdkOptions.env`)
- **Provider models (built-in):** `server/modules/providers/services/provider-models.service.ts`

## Dependencies

- **Chat & Agent Streaming** — The composer and message flow.
- **Provider Integration** — Each runtime reads its own native command directory.
- **Authentication & Security** — Authenticated command execution; path validation against the active provider's directory.
