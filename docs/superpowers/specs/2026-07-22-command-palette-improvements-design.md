# Design: Command palette fixes — insert-not-execute, input highlighting, 4-way grouping

**Date:** 2026-07-22
**Status:** Approved for implementation planning
**Provider scope:** Primarily Claude (the built-in-command sourcing in §3 is Claude-specific); §1 and §2 are provider-agnostic composer behavior.
**Related:** builds on findings from [`2026-07-22-subagent-fork-subtask-support-design.md`](./2026-07-22-subagent-fork-subtask-support-design.md) — `/fork` and `/subtask`, once implemented per that spec, are Claude Code built-in commands from the user's point of view and belong in the "Claude Code built-in" group defined here (§3), not a separate "ccui" group, even though ccui's backend has to intercept and translate them (an implementation detail, not something the categorization should expose).

## Problem

Three issues in the composer's slash-command experience (`ChatComposer.tsx`, `useSlashCommands.ts`, `useChatComposerState.ts`, `CommandMenu.tsx`):

1. **Selecting a command from the dropdown executes it immediately**, with no chance to type arguments first. Skills already behave correctly (selecting one just inserts the name into the input); non-skill commands (built-in or custom `.md`) do not.
2. **No visual highlighting** of a recognized `/command` token while typing, unlike Claude Code's own interactive input.
3. **The dropdown's grouping is misleading.** The bucket currently labeled "Built-in Commands" is actually six commands ccui itself invented (`/help`, `/models`, `/cost`, `/memory`, `/config`, `/status` — each fully handled client/server-side, never touching the real CLI). Claude Code's *actual* built-in commands (`/clear`, `/compact`, `/context`, `/usage`, and — once implemented — `/fork`/`/subtask`) don't appear in the list at all today. Skills are also not split by scope (user vs. project), unlike custom commands, which already are.

## Design

### 1. Selecting a command inserts, it never auto-executes

`useSlashCommands.ts` already has the right mechanism (`insertCommandIntoInput`) — it's just gated behind `isSkillCommand(command)`. Remove the gate: `selectCommandFromKeyboard` and `handleCommandSelect` call `insertCommandIntoInput` unconditionally, and the `executeNonSkillCommand` branch (and the function itself, if nothing else calls it) is deleted.

No change needed anywhere else: `useChatComposerState.ts`'s `handleSubmit` (lines ~813-846) already intercepts a leading `/` on real submit, matches it against `slashCommands`, extracts everything after the command name as args via `commandMatch[1]`, and calls `executeCommand(matchedCommand, commandInput)` with the full text — arguments already flow through correctly once the command reaches the textarea as plain text. The only broken step was the dropdown short-circuiting straight to execution before the user could type anything.

### 2. Highlight the recognized command token

Extend the existing overlay mechanism rather than building a new one. `ChatComposer.tsx` already renders `inputHighlightRef`'s div (`pointer-events-none absolute inset-0`, scroll-synced via `syncInputOverlayScroll`) showing `renderInputWithMentions(input)` — `useFileMentions.tsx:152` splits the text on a mention regex and wraps matches in `<span className="... bg-blue-200/70 ... text-transparent ...">`, letting the highlight color show through while the real character glyphs come from the actual `<textarea>` underneath.

Add the same technique for commands: a second regex pass (or a combined one) that recognizes a leading `/word` matching a known command name (from `slashCommands`, so only *valid* commands light up — typing `/asdf` with no match stays plain), wrapped in a span styled distinctly from the mention color (e.g. indigo/purple background) to avoid visual confusion with file mentions. This can live in `useSlashCommands.ts` (new `renderInputWithCommandHighlight` or folded into a shared render step) or be composed with `renderInputWithMentions` in `ChatComposer.tsx` — implementation detail, not a design fork.

### 3. Four-way grouping, sourced correctly

Target groups (`CommandMenu.tsx`'s existing namespace-grouping mechanism already supports N groups with per-group icon/label/color — no structural change needed there, only what feeds it):

| Group | Contents | Source |
|---|---|---|
| **ccui commands** | The 6 existing ccui-invented pseudo-commands | `builtInCommands` in `server/routes/commands.js` (unchanged) — but relabeled from `"builtin"` to something like `"ccui"` in both the namespace value and `namespaceLabels`/icons in `CommandMenu.tsx`, to stop conflating it with real CLI built-ins |
| **Claude Code built-in** | `/clear`, `/compact`, `/context`, `/usage`, `/fork`, `/subtask`, etc. | New — see below |
| **Project scope** | Custom `.md` commands from `<project>/.claude/commands/` **and** skills with `scope: 'project'` | Existing custom-command scan (already scoped) + fix to skill mapping (below) |
| **User scope** | Custom `.md` commands from `~/.claude/commands/` **and** skills with `scope: 'user'` | Same |

**Sourcing real Claude Code built-ins (chosen over hardcoding):** capture `message.slash_commands` from the `system/init` message that every Claude session already receives on startup — `server/claude-sdk.js` currently ignores this message entirely. Rejected alternative: hardcode a static list (mirrors ccui's own `builtInCommands` pattern) — rejected because it reproduces exactly the class of bug this investigation started with (Task→Agent): a hardcoded assumption about Claude Code's surface silently goes stale as the CLI evolves.

Implementation:
- `claude-sdk.js` adds a case for `message.type === 'system' && message.subtype === 'init'`: overwrite a module-level cache (e.g. `let cachedClaudeBuiltinCommands: string[] | null`) with `message.slash_commands`. This is a server-process-lifetime cache, not per-session — the set of built-in commands is a property of the installed Claude Code binary, not of any one conversation, so every session's init opportunistically refreshes it (self-healing after a CLI upgrade, no restart required beyond the next session).
- A small static `name → description` map covers commonly-used entries (`clear`, `compact`, `context`, `usage`, `fork`, `subtask`, ...); any cached name without a map entry still appears in the list with a generic fallback description ("Claude Code built-in command") rather than being dropped — same tolerant-fallback principle already used for custom-command frontmatter parsing.
- Expose the cache through the existing `/api/commands/list` response (add a `claudeBuiltIn` array alongside today's `builtIn`/`custom`) rather than a new endpoint, so `useSlashCommands.ts` only needs one extra mapped array, not an extra fetch.
- Cold-start behavior (server just restarted, no session has initialized yet this process lifetime): the group is simply empty/absent until the first session of the process starts — acceptable; it self-populates within one message and every subsequent palette open in that server process has it.

**Fixing skill scope:** `mapSkillToSlashCommand` (`useSlashCommands.ts:88`) currently hardcodes `namespace: 'skill'` regardless of where the skill came from. Change it to `namespace: skill.scope === 'project' ? 'project' : 'user'` (the `ProviderSkill.scope` field already carries this — confirmed present in the type at `useSlashCommands.ts:33`), so skills merge into the same project/user buckets as custom commands instead of a separate always-mixed "Skills" bucket. `CommandMenu.tsx`'s per-item badge (`command.metadata?.type`) still distinguishes a skill from a command within a merged group, so nothing is lost — it's one less top-level group, not less information.

`CommandMenu.tsx` changes: update `namespaceLabels`/`namespaceIcons`/`namespaceAccentClasses` to the four keys above (`ccui`, `claudeBuiltin`, `project`, `user`) plus keep `frequent`/`other` as-is; update `preferredOrder`.

## Non-goals

- No change to how `/fork`/`/subtask` are dispatched — that's fully specified in the companion spec. This spec only ensures they *show up* in the right group once implemented.
- No change to other providers' command sourcing (Cursor/Codex/OpenCode keep whatever grouping they already get from `providerCommandDirs`); the "Claude Code built-in" group is Claude-only by definition, and other providers simply won't have that group populated.
- No redesign of `CommandMenu.tsx`'s visual layout beyond the group set — existing per-group styling/icon mechanism is reused as-is.

## Verification plan

- Manual: open the command menu, select a custom `.md` command with `argument-hint` — confirm it inserts (not executes) and typing args + Enter dispatches with them.
- Manual: type `/clear` (or another confirmed-real built-in) and a made-up `/zzz` — confirm only the former highlights.
- Manual: restart the dev server, open a project with no active session, confirm the "Claude Code built-in" group is absent; send one message; reopen the palette and confirm it now appears.
- Manual: confirm a project-scope skill and a user-scope skill land in the correct group, sitting alongside project/user custom commands rather than in a separate "Skills" bucket.
