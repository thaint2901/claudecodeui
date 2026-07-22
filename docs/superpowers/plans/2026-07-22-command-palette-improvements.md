# Command Palette Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Selecting a slash command inserts it (never auto-executes), the recognized `/command` token is highlighted in the composer, and the dropdown groups commands into ccui / Claude Code built-in / project / user.

**Architecture:** Three independent fixes to the existing composer pipeline. (1) Remove the execute-on-select branch in `useSlashCommands.ts` so every palette selection inserts text. (2) A new dependency-free server module caches the `slash_commands` array from Claude's `system/init` message (captured in `claude-sdk.js`'s stream loop) and `/api/commands/list` exposes it; the frontend maps it into a new "Claude Code built-in" group, relabels ccui's six pseudo-commands from "builtin" to "ccui", and splits skills into project/user scope groups. (3) The existing text-transparent overlay (used for `@file` mentions) gains a second span type that tints a leading `/command` token when it matches a known command.

**Tech Stack:** React 18 + TypeScript (frontend), Express ESM JS (backend), node:test via `node --test` / `npx tsx --test` (no `npm test` exists in this repo).

**Spec:** `docs/superpowers/specs/2026-07-22-command-palette-improvements-design.md`

## Global Constraints

- Node 22+ (`.nvmrc`); backend is ESM `.js`, frontend is TS/TSX. Two `@/` aliases: frontend `@/*` → `src/*`, backend `@/*` → `server/*` — never cross them.
- No `npm test`. Server pure-module tests run with `node --test <path>`; TS tests with `npx tsx --test --tsconfig server/tsconfig.json <path>`. Frontend pure helpers: `npx tsx --test <path>` (no `@/` imports allowed in those helpers).
- Conventional Commits enforced by commitlint (`feat`, `fix`, `refactor`, `docs`, `chore`...). Scope encouraged: `feat(chat): ...`.
- `npm run typecheck` (both tsconfigs) and `npm run lint` must pass before every commit.
- Do NOT change how ccui's six pseudo-commands *execute* (`/api/commands/execute` + `builtInHandlers`) — only their display namespace changes. The execution result `type: "builtin"` in `commands.js` handlers is a different concept from the display namespace and must not be touched.
- Do NOT implement `/fork`/`/subtask` dispatch — companion spec. They will appear in the Claude-built-in group automatically once the CLI reports them.
- Dev server gotcha: backend does not hot-reload (`server:dev` is plain `tsx`); restart it to see server changes. Browse `localhost:5173`, never `:3001`.

---

### Task 1: Palette selection inserts the command instead of executing it

**Files:**
- Modify: `src/components/chat/hooks/useSlashCommands.ts`

**Interfaces:**
- Consumes: existing `insertCommandIntoInput(command)` (unchanged).
- Produces: `useSlashCommands` no longer accepts `onExecuteCommand`; its options type drops that field. `useChatComposerState.ts` still owns `executeCommand` for the submit path — untouched here except the call-site option removal.

Currently `selectCommandFromKeyboard` (line ~336) and `handleCommandSelect` (line ~348) route non-skill commands to `executeNonSkillCommand`, which fires the command immediately with no chance to type arguments. Skills already insert-then-wait. Make every command behave like skills.

- [ ] **Step 1: Edit `useSlashCommands.ts` — remove the execute-on-select path**

Replace `selectCommandFromKeyboard` and `handleCommandSelect` bodies so both always insert:

```ts
  const selectCommandFromKeyboard = useCallback(
    (command: SlashCommand) => {
      insertCommandIntoInput(command);
    },
    [insertCommandIntoInput],
  );

  const handleCommandSelect = useCallback(
    (command: SlashCommand | null, index: number, isHover: boolean) => {
      if (!command || !selectedProject) {
        return;
      }

      if (isHover) {
        setSelectedCommandIndex(index);
        return;
      }

      trackCommandUsage(command);
      insertCommandIntoInput(command);
    },
    [selectedProject, trackCommandUsage, insertCommandIntoInput],
  );
```

Then delete the now-unused: `executeNonSkillCommand` (whole function), `isPromiseLike` helper, `isSkillCommand` helper (its only callers were the two functions just edited — confirm with grep before deleting), and the `onExecuteCommand` field from `UseSlashCommandsOptions` plus its destructuring in the hook signature.

- [ ] **Step 2: Remove the dead option at the call site**

In `src/components/chat/hooks/useChatComposerState.ts` (~line 600), remove the line `onExecuteCommand: executeCommand,` from the `useSlashCommands({...})` call. `executeCommand` itself stays — `handleSubmit` and `showCostModal` still use it.

- [ ] **Step 3: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: both pass; lint confirms no unused-variable leftovers.

- [ ] **Step 4: Manual verify**

With `npm run dev` running, open `localhost:5173`, type `/` in the composer, pick a custom command (e.g. any project `.md` command) with Enter or click. Expected: the command name appears in the input followed by a space, cursor after it, nothing executes. Type `arg1 arg2` + Enter: the command dispatches with args (existing `handleSubmit` interception at `useChatComposerState.ts:~816` already parses args — no change needed there for this task).

- [ ] **Step 5: Commit**

```bash
git add src/components/chat/hooks/useSlashCommands.ts src/components/chat/hooks/useChatComposerState.ts
git commit -m "fix(chat): palette selection inserts command instead of executing immediately"
```

---

### Task 2: Server cache module for Claude built-in commands (TDD)

**Files:**
- Create: `server/utils/claude-builtin-commands.js`
- Test: `server/utils/claude-builtin-commands.test.js`

**Interfaces:**
- Produces: `setClaudeBuiltinCommands(names: string[])` — overwrites the cache; ignores non-array input. `getClaudeBuiltinCommandEntries(excludeNames?: string[])` — returns `Array<{name, description, namespace: 'claude-builtin', metadata: {type: 'claude-builtin'}}>`, names prefixed with `/`, excluding any entry whose slash-name is in `excludeNames`, `[]` when nothing captured yet. Both consumed by Task 3.
- No imports from `@/` or any project file — must stay dependency-free so `node --test` runs it directly (same pattern as `server/routes/tests/commands-paths.test.js`).

- [ ] **Step 1: Write the failing test**

Create `server/utils/claude-builtin-commands.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  setClaudeBuiltinCommands,
  getClaudeBuiltinCommandEntries,
} from './claude-builtin-commands.js';

test('returns empty array before any capture', () => {
  setClaudeBuiltinCommands(null); // reset/ignore invalid
  assert.deepEqual(getClaudeBuiltinCommandEntries(), []);
});

test('maps captured names to slash-prefixed entries with descriptions', () => {
  setClaudeBuiltinCommands(['clear', 'compact', 'zzz-unknown']);
  const entries = getClaudeBuiltinCommandEntries();
  assert.equal(entries.length, 3);
  const clear = entries.find((e) => e.name === '/clear');
  assert.ok(clear);
  assert.equal(clear.namespace, 'claude-builtin');
  assert.equal(clear.metadata.type, 'claude-builtin');
  assert.match(clear.description, /context/i);
  const unknown = entries.find((e) => e.name === '/zzz-unknown');
  assert.equal(unknown.description, 'Claude Code built-in command');
});

test('later capture overwrites earlier capture', () => {
  setClaudeBuiltinCommands(['clear']);
  setClaudeBuiltinCommands(['compact']);
  assert.deepEqual(getClaudeBuiltinCommandEntries().map((e) => e.name), ['/compact']);
});

test('excludeNames filters collisions with ccui pseudo-commands', () => {
  setClaudeBuiltinCommands(['config', 'clear']);
  const entries = getClaudeBuiltinCommandEntries(['/config']);
  assert.deepEqual(entries.map((e) => e.name), ['/clear']);
});

test('non-array input is ignored, keeping previous cache', () => {
  setClaudeBuiltinCommands(['clear']);
  setClaudeBuiltinCommands(undefined);
  assert.deepEqual(getClaudeBuiltinCommandEntries().map((e) => e.name), ['/clear']);
});
```

Note: `setClaudeBuiltinCommands(null)` in the first test doubles as documentation that invalid input never throws. Because module state persists across tests in one process, the first test must run before any valid capture — node:test runs tests in declaration order in a single file, so this ordering is safe.

- [ ] **Step 2: Run to verify failure**

Run: `node --test server/utils/claude-builtin-commands.test.js`
Expected: FAIL — `Cannot find module ... claude-builtin-commands.js`

- [ ] **Step 3: Implement the module**

Create `server/utils/claude-builtin-commands.js`:

```js
/**
 * Process-lifetime cache of the Claude Code CLI's built-in slash commands.
 *
 * The set of built-in commands is a property of the installed Claude Code
 * binary, not of any one conversation, so a single module-level cache is
 * correct: every session's `system/init` message opportunistically refreshes
 * it (self-healing after a CLI upgrade — no server restart needed beyond the
 * next session). Names arrive WITHOUT the leading slash (e.g. "clear").
 *
 * Dependency-free on purpose: testable with plain `node --test`.
 */

/** Descriptions for commonly used built-ins; anything absent gets a generic fallback. */
const KNOWN_DESCRIPTIONS = {
  clear: 'Start a new conversation with empty context',
  compact: 'Free up context by summarizing the conversation',
  context: 'Visualize current context usage',
  usage: 'Show plan usage limits',
  cost: 'Show token usage information',
  init: 'Initialize the project with a CLAUDE.md guide',
  review: 'Review a pull request',
  insights: 'Generate a report analyzing your Claude Code sessions',
  goal: 'Set a goal for Claude to work toward',
  fork: 'Copy the conversation into a new background session',
  subtask: 'Hand a side task to a subagent that reports back here',
};

const FALLBACK_DESCRIPTION = 'Claude Code built-in command';

let cachedNames = [];

export function setClaudeBuiltinCommands(names) {
  if (!Array.isArray(names)) {
    return;
  }
  cachedNames = names.filter((name) => typeof name === 'string' && name.length > 0);
}

export function getClaudeBuiltinCommandEntries(excludeNames = []) {
  const excluded = new Set(excludeNames);
  return cachedNames
    .map((name) => `/${name}`)
    .filter((slashName) => !excluded.has(slashName))
    .map((slashName) => ({
      name: slashName,
      description: KNOWN_DESCRIPTIONS[slashName.slice(1)] || FALLBACK_DESCRIPTION,
      namespace: 'claude-builtin',
      metadata: { type: 'claude-builtin' },
    }));
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test server/utils/claude-builtin-commands.test.js`
Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/utils/claude-builtin-commands.js server/utils/claude-builtin-commands.test.js
git commit -m "feat(commands): add process-lifetime cache for Claude built-in slash commands"
```

---

### Task 3: Capture `system/init` in claude-sdk.js and expose the group via /api/commands/list

**Files:**
- Modify: `server/claude-sdk.js` (stream loop, ~line 639-679)
- Modify: `server/routes/commands.js` (`builtInCommands` array lines 181-218, list handler lines 459-505)

**Interfaces:**
- Consumes: `setClaudeBuiltinCommands`, `getClaudeBuiltinCommandEntries` from Task 2.
- Produces: `POST /api/commands/list` response gains `claudeBuiltIn: CommandEntry[]` (empty for non-claude providers and before the first Claude session of the server process); the six ccui pseudo-commands change `namespace`/`metadata.type` from `"builtin"` to `"ccui"`. The `builtIn` response key keeps its name. Consumed by Task 4.

- [ ] **Step 1: Capture the init message in `server/claude-sdk.js`**

Add the import near the other top-of-file imports:

```js
import { setClaudeBuiltinCommands } from './utils/claude-builtin-commands.js';
```

Inside the `for await (const message of queryInstance) {` loop (line ~639), directly after the session-id capture block and before `const transformedMessage = transformMessage(message);`, add:

```js
      // The init message enumerates the CLI's dispatchable built-in commands.
      // Cache them process-wide so /api/commands/list can group them for the
      // palette — sourced live from the running binary, never hardcoded.
      if (message.type === 'system' && message.subtype === 'init') {
        setClaudeBuiltinCommands(message.slash_commands);
      }
```

- [ ] **Step 2: Relabel the ccui pseudo-commands in `server/routes/commands.js`**

In the `builtInCommands` array (lines 181-218) change all six entries from `namespace: "builtin"` / `metadata: { type: "builtin" }` to `namespace: "ccui"` / `metadata: { type: "ccui" }`.

Then fix the filter that separates custom commands (line ~487):

```js
    const customCommands = allCommands.filter(
      (cmd) => cmd.namespace !== "ccui",
    );
```

Do NOT touch the `type: "builtin"` values inside `builtInHandlers` return objects — that field is the execution-result discriminator the frontend switches on (`result.type === 'builtin'` in `useChatComposerState.ts`), a different concept from the display namespace.

- [ ] **Step 3: Expose the Claude built-in group in the list response**

In `server/routes/commands.js`, add the import:

```js
import { getClaudeBuiltinCommandEntries } from "../utils/claude-builtin-commands.js";
```

In the `/list` handler, change the response (lines ~493-497) to:

```js
    // Claude Code's own built-ins, captured live from the CLI's system/init
    // message. Collisions with ccui pseudo-commands are excluded so a name
    // appears in exactly one group (ccui wins: it intercepts dispatch first).
    const claudeBuiltIn = provider === "claude"
      ? getClaudeBuiltinCommandEntries(builtInCommands.map((cmd) => cmd.name))
      : [];

    res.json({
      builtIn: builtInCommands,
      claudeBuiltIn,
      custom: customCommands,
      count: allCommands.length + claudeBuiltIn.length,
    });
```

- [ ] **Step 4: Typecheck, lint, and existing tests**

Run: `npm run typecheck && npm run lint && node --test server/utils/claude-builtin-commands.test.js server/routes/tests/commands-paths.test.js`
Expected: all pass.

- [ ] **Step 5: Manual verify the end-to-end capture**

Restart the dev server (backend has no hot-reload). Send one message in any Claude session, then:

```bash
TOKEN=$(cat <<'EOF' | node --input-type=module
import Database from 'better-sqlite3';
import jwt from 'jsonwebtoken';
import os from 'node:os';
const db = new Database(`${os.homedir()}/.cloudcli/auth.db`, { readonly: true });
const secret = db.prepare("SELECT value FROM app_config WHERE key='jwt_secret'").get().value;
const user = db.prepare('SELECT id, username FROM users LIMIT 1').get();
console.log(jwt.sign({ userId: user.id, username: user.username }, secret));
EOF
)
curl -s -X POST http://localhost:3001/api/commands/list \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"projectPath":"/home/thaint/projects/claudecodeui","provider":"claude"}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log('claudeBuiltIn:',j.claudeBuiltIn.slice(0,5));console.log('ccui namespace:',j.builtIn[0].namespace)})"
```

Expected: `claudeBuiltIn` contains entries like `{name:'/clear', namespace:'claude-builtin',...}`; `ccui namespace: ccui`. Before any Claude session has run in this server process, `claudeBuiltIn` is `[]` — that cold-start behavior is by design.

- [ ] **Step 6: Commit**

```bash
git add server/claude-sdk.js server/routes/commands.js
git commit -m "feat(commands): capture Claude built-in slash commands from system/init and expose in /list"
```

---

### Task 4: Frontend grouping — claude-builtin group, skill scope split, dispatch fall-through

**Files:**
- Modify: `src/components/chat/hooks/useSlashCommands.ts` (fetch mapping, `mapSkillToSlashCommand`)
- Modify: `src/components/chat/hooks/useChatComposerState.ts` (`handleSubmit` interception; `/help` fallback + `showCostModal` namespace strings)

**Interfaces:**
- Consumes: `claudeBuiltIn` array from Task 3's response.
- Produces: `SlashCommand` entries with `type: 'claude-builtin'` and `namespace: 'claude-builtin'`; skills carry `namespace: 'project' | 'user'` (still `type: 'skill'`). Task 5 consumes these namespaces; Task 6 consumes the full name list.

- [ ] **Step 1: Map the new group and split skill scope in `useSlashCommands.ts`**

In the `fetchCommands` function, extend the merge (currently `allCommands = [built-in..., skills..., custom...]`):

```ts
        const allCommands: SlashCommand[] = [
          // ccui pseudo-commands come first: for a colliding name, dispatch
          // interception in handleSubmit finds the ccui entry first.
          ...((data.builtIn || []) as SlashCommand[]).map((command) => ({
            ...command,
            type: 'built-in',
          })),
          ...((data.claudeBuiltIn || []) as SlashCommand[]).map((command) => ({
            ...command,
            type: 'claude-builtin',
          })),
          ...skillCommands,
          ...((data.custom || []) as SlashCommand[]).map((command) => ({
            ...command,
            type: 'custom',
          })),
        ];
```

Change `mapSkillToSlashCommand` (~line 88) so skills group by their real scope instead of one mixed bucket — only the `namespace` line changes:

```ts
const mapSkillToSlashCommand = (skill: ProviderSkill): SlashCommand => ({
  name: skill.command,
  description: skill.description,
  namespace: skill.scope === 'project' ? 'project' : 'user',
  path: skill.sourcePath,
  type: 'skill',
  metadata: {
    type: 'skill',
    scope: skill.scope,
    sourcePath: skill.sourcePath,
    pluginName: skill.pluginName,
    pluginId: skill.pluginId,
    skillName: skill.name,
  },
});
```

Note `metadata.type` becomes `'skill'` (was `skill.scope`): the per-item badge in `CommandMenu.tsx` renders `command.metadata?.type`, and with skills now sitting inside the project/user groups the badge must say what the item IS (a skill) rather than repeat the group it's in.

- [ ] **Step 2: Let claude-builtin commands fall through to the runtime**

In `useChatComposerState.ts` `handleSubmit` (~line 832), the interception currently executes anything matched that isn't a skill. Claude built-ins must NOT go to `/api/commands/execute` (no handler exists there — it would 404); they dispatch by sending the slash text to the runtime, which is exactly what the non-intercepted path already does. Change:

```ts
        if (matchedCommand && matchedCommand.type !== 'skill' && matchedCommand.type !== 'claude-builtin') {
```

(The repo convention in CLAUDE.md — "cloudcli forwards the slash form (`/cmd args`) to the active session's runtime" — is precisely this fall-through.)

Also update the two leftover `'builtin'` namespace literals for consistency with Task 3's relabel: the `/help` fallback object in `handleSubmit` (~line 828) and the `showCostModal` command object (~line 579) both say `namespace: 'builtin', metadata: { type: 'builtin' }` — change both to `'ccui'`. (These fields don't affect execution — `/api/commands/execute` looks up by name — but a grep for the stale label should come up empty after this plan.)

- [ ] **Step 3: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: pass.

- [ ] **Step 4: Manual verify**

Restart dev server, run one Claude message (populates the cache), reload `localhost:5173`:
- Type `/cle` → `/clear` appears in the menu.
- Select it (inserts, per Task 1), press Enter → the message `/clear` is sent as a normal chat.send; no "Failed to execute command" error appears.
- Type `/` and confirm a project-scope skill shows in the same group as project `.md` commands (verification of exact group labels happens in Task 5 — here it's enough that its `namespace` is no longer `skill`, e.g. via React devtools or by the item moving out of the "Skills" section).

- [ ] **Step 5: Commit**

```bash
git add src/components/chat/hooks/useSlashCommands.ts src/components/chat/hooks/useChatComposerState.ts
git commit -m "feat(chat): claude-builtin command group with runtime fall-through; skills grouped by scope"
```

---

### Task 5: CommandMenu group labels, icons, order

**Files:**
- Modify: `src/components/chat/view/subcomponents/CommandMenu.tsx` (lines 52-77 maps, line ~217 `preferredOrder`)

**Interfaces:**
- Consumes: namespaces `ccui`, `claude-builtin`, `project`, `user` from Tasks 3-4.
- Produces: display-only changes; nothing downstream consumes these.

- [ ] **Step 1: Update the three namespace maps**

Replace the `builtin`/`skill` keys with the new set (keep `frequent`/`other`):

```ts
const namespaceLabels: Record<string, string> = {
  frequent: 'Frequently Used',
  ccui: 'CloudCLI Commands',
  'claude-builtin': 'Claude Code Built-in',
  project: 'Project Commands & Skills',
  user: 'User Commands & Skills',
  other: 'Other Commands',
};

const namespaceIcons: Record<string, LucideIcon> = {
  frequent: Star,
  ccui: Terminal,
  'claude-builtin': Sparkles,
  project: Folder,
  user: User,
  other: MessageSquare,
};

const namespaceAccentClasses: Record<string, string> = {
  frequent: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-200',
  ccui: 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-400/20 dark:bg-sky-400/10 dark:text-sky-200',
  'claude-builtin': 'border-orange-200 bg-orange-50 text-orange-700 dark:border-orange-400/20 dark:bg-orange-400/10 dark:text-orange-200',
  project: 'border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-400/20 dark:bg-indigo-400/10 dark:text-indigo-200',
  user: 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-400/20 dark:bg-rose-400/10 dark:text-rose-200',
  other: 'border-gray-200 bg-gray-50 text-gray-600 dark:border-gray-500/20 dark:bg-gray-500/10 dark:text-gray-200',
};
```

(Sparkles/emerald was the skills accent; skills now live inside project/user, so Sparkles is reassigned to the Claude group with a new orange accent to avoid implying "these are skills". All icons above are already imported at the top of the file — no import changes needed.)

- [ ] **Step 2: Update the ordering**

```ts
  const preferredOrder = hasFrequentCommands
    ? ['frequent', 'ccui', 'claude-builtin', 'project', 'user', 'other']
    : ['ccui', 'claude-builtin', 'project', 'user', 'other'];
```

- [ ] **Step 3: Typecheck, lint, manual verify**

Run: `npm run typecheck && npm run lint`
Expected: pass.
Manual: open the palette. Expected groups in order: CloudCLI Commands (6 entries, Terminal icon), Claude Code Built-in (populated after one Claude message this server-process), Project Commands & Skills, User Commands & Skills. Skills show a small `skill` badge inside their scope group.

- [ ] **Step 4: Commit**

```bash
git add src/components/chat/view/subcomponents/CommandMenu.tsx
git commit -m "feat(chat): regroup command palette into ccui/claude-builtin/project/user sections"
```

---

### Task 6: Highlight the recognized command token in the composer (TDD on the pure helper)

**Files:**
- Create: `src/components/chat/utils/commandToken.ts`
- Test: `src/components/chat/utils/commandToken.test.ts`
- Modify: `src/components/chat/hooks/useChatComposerState.ts` (expose `slashCommandNames`)
- Modify: `src/components/chat/view/ChatInterface.tsx` (pass the prop, ~line 440-485)
- Modify: `src/components/chat/view/subcomponents/ChatComposer.tsx` (overlay render, lines 426-429; props type)

**Interfaces:**
- Produces: `matchLeadingCommand(text: string, commandNames: ReadonlySet<string>): { command: string; rest: string } | null` — `command` includes the leading `/`; `rest` is everything after it (leading space preserved). `slashCommandNames: Set<string>` returned from `useChatComposerState`.
- The helper must not import anything project-local (keeps `npx tsx --test` alias-free).

- [ ] **Step 1: Write the failing test**

Create `src/components/chat/utils/commandToken.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { matchLeadingCommand } from './commandToken.js';

const names = new Set(['/clear', '/fork', '/prp-commit', '/telegram:access']);

test('matches a known leading command and splits off the rest', () => {
  assert.deepEqual(matchLeadingCommand('/clear', names), { command: '/clear', rest: '' });
  assert.deepEqual(matchLeadingCommand('/fork review the diff', names), {
    command: '/fork',
    rest: ' review the diff',
  });
});

test('supports dashes and namespaced colon commands', () => {
  assert.equal(matchLeadingCommand('/prp-commit msg', names)?.command, '/prp-commit');
  assert.equal(matchLeadingCommand('/telegram:access', names)?.command, '/telegram:access');
});

test('returns null for unknown commands, non-leading slashes, and plain text', () => {
  assert.equal(matchLeadingCommand('/zzz nope', names), null);
  assert.equal(matchLeadingCommand('say /clear later', names), null);
  assert.equal(matchLeadingCommand('hello', names), null);
  assert.equal(matchLeadingCommand('', names), null);
});

test('longer names are not truncated into shorter known ones', () => {
  // '/clearx' is one token; it must not highlight as '/clear'.
  assert.equal(matchLeadingCommand('/clearx', names), null);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test src/components/chat/utils/commandToken.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

Create `src/components/chat/utils/commandToken.ts`:

```ts
/**
 * Splits a leading slash-command token off the composer text, but only when
 * it exactly matches a known command name — unknown "/words" stay plain so
 * the highlight never lies about what will dispatch.
 */
export function matchLeadingCommand(
  text: string,
  commandNames: ReadonlySet<string>,
): { command: string; rest: string } | null {
  const match = /^(\/[^\s]+)([\s\S]*)$/.exec(text);
  if (!match) {
    return null;
  }
  if (!commandNames.has(match[1])) {
    return null;
  }
  return { command: match[1], rest: match[2] };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx tsx --test src/components/chat/utils/commandToken.test.ts`
Expected: 4 tests PASS.

- [ ] **Step 5: Expose the known-name set from `useChatComposerState`**

In `useChatComposerState.ts`: `slashCommands` is already destructured from `useSlashCommands` (~line 588). Add a memo below the destructuring (import `useMemo` — already imported? check the top: the file imports `useCallback, useEffect, useRef, useState`; add `useMemo`):

```ts
  const slashCommandNames = useMemo(
    () => new Set(slashCommands.map((command) => command.name)),
    [slashCommands],
  );
```

Add `slashCommandNames,` to the hook's return object (next to `slashCommandsCount`).

- [ ] **Step 6: Wire it into the overlay in `ChatComposer.tsx`**

In `src/components/chat/view/ChatInterface.tsx`, destructure `slashCommandNames` from the `useChatComposerState(...)` result (~line 166 block) and pass it to `<ChatComposer ... slashCommandNames={slashCommandNames} />` (~line 440-485, next to `renderInputWithMentions`).

In `ChatComposer.tsx`: add to the props type `slashCommandNames: ReadonlySet<string>;` (next to `renderInputWithMentions`'s declaration, ~line 100-101), destructure it (~line 168), import the helper at the top:

```ts
import { matchLeadingCommand } from '../../utils/commandToken';
```

Replace the overlay body (line 428, currently `{renderInputWithMentions(input)}`):

```tsx
                {(() => {
                  const leadingCommand = matchLeadingCommand(input, slashCommandNames);
                  if (!leadingCommand) {
                    return renderInputWithMentions(input);
                  }
                  return (
                    <>
                      <span className="-ml-0.5 rounded-md bg-indigo-200/70 box-decoration-clone px-0.5 text-transparent dark:bg-indigo-400/30">
                        {leadingCommand.command}
                      </span>
                      {renderInputWithMentions(leadingCommand.rest)}
                    </>
                  );
                })()}
```

(The container div already has `text-transparent` and the textarea renders the real glyphs on top — same mechanism as the blue `@file` mention tint from `useFileMentions.tsx:166`; indigo distinguishes commands from mentions.)

- [ ] **Step 7: Typecheck, lint, manual verify**

Run: `npm run typecheck && npm run lint`
Expected: pass.
Manual on `localhost:5173`: type `/clear` → the token gets an indigo tint; keep typing ` please` → only the token stays tinted. Type `/zzz` → no tint. Type `@` + pick a file after a command → mention tint (blue) and command tint (indigo) coexist. Confirm the tint scrolls in sync in a multi-line input (overlay scroll-sync via `syncInputOverlayScroll` / prop `onTextareaScrollSync` is untouched).

- [ ] **Step 8: Commit**

```bash
git add src/components/chat/utils/commandToken.ts src/components/chat/utils/commandToken.test.ts src/components/chat/hooks/useChatComposerState.ts src/components/chat/view/ChatInterface.tsx src/components/chat/view/subcomponents/ChatComposer.tsx
git commit -m "feat(chat): highlight recognized slash-command token in composer input"
```

---

### Task 7: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Automated checks**

Run: `npm run typecheck && npm run lint && node --test server/utils/claude-builtin-commands.test.js server/routes/tests/commands-paths.test.js && npx tsx --test src/components/chat/utils/commandToken.test.ts`
Expected: everything passes.

- [ ] **Step 2: Spec verification checklist (manual, from the spec's own plan)**

1. Open the command menu, select a custom `.md` command with `argument-hint` — confirm it inserts (not executes); type args + Enter dispatches with them.
2. Type `/clear` and a made-up `/zzz` — only the former highlights.
3. Restart the dev server, open the palette before any Claude message this process — "Claude Code Built-in" group absent; send one message; reopen — it appears.
4. A project-scope skill and a user-scope skill land in their scope groups alongside custom commands; no separate "Skills" bucket remains.
5. Cursor/OpenCode session: palette shows no "Claude Code Built-in" group (server returns `[]` for non-claude providers).
6. `grep -rn "namespace: 'builtin'\|namespace: \"builtin\"" src server` returns nothing.

- [ ] **Step 3: Final commit if any stragglers**

```bash
git status --short
```

Expected: clean tree. If verification fixes were needed, commit them with `fix(chat): ...`.
