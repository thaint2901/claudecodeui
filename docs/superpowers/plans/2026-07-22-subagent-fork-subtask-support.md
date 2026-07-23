# Subagent Rendering Fix + /fork + /subtask Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make subagent activity render correctly (grouped, live and persisted alike, with a full-transcript drawer), and add `/fork` (branch to independent session) and `/subtask` (in-session forked subagent) commands for the Claude provider.

**Architecture:** One data contract — every subagent-child message carries `parentToolUseId` — satisfied natively by the live SDK stream and by a new stamping step in the persisted JSONL reader. One client-side grouping pass in `normalizedToChatMessages()` consumes it. `/fork` is intercepted in the WebSocket chat handler and translated to an SDK `forkSession` call against a freshly allocated app session; `/subtask` is a prompt rewrite in the same handler.

**Tech Stack:** Express + ws backend (ESM JS + TS), `@anthropic-ai/claude-agent-sdk` v0.3.x, React 18 frontend, `node:test` via `npx tsx --test` for tests.

**Spec:** `docs/superpowers/specs/2026-07-22-subagent-fork-subtask-support-design.md` (read it before starting; it contains the verified root causes).

## Global Constraints

- Claude provider ONLY. Do not touch Cursor/Codex/OpenCode code paths.
- Match subagent tool name against BOTH `'Agent'` (current) and `'Task'` (legacy) — never only one.
- Never hardcode the string `'claude'` when spawning; the existing `resolveClaudeCodeExecutablePath` path in `claude-sdk.js` is already correct — don't disturb it.
- Tools-disabled-by-default stays: only the `Agent`/`Task` dispatch tool is auto-allowed, nothing else.
- Backend module boundary lint applies: cross-module imports go through barrels; `server/routes/` and `server/claude-sdk.js` are legacy top-level files where direct imports are fine.
- No new npm dependencies.
- Conventional commits (`feat(chat): …`, `fix(server): …`); husky runs lint-staged on commit.
- Test runner: `npx tsx --test --tsconfig server/tsconfig.json <path>` for server `.test.ts` files (resolves the `@/` alias); plain `npx tsx --test <path>` for dependency-free frontend helpers. There is NO `npm test`.
- Typecheck gate: `npm run typecheck` (checks both tsconfigs) must pass at every commit.

---

### Task 1: Shared subagent tool-name helper + fix the three stale `'Task'` checks

The subagent dispatch tool is named `Agent` in current Claude Code (verified in real JSONL, v2.1.217); three frontend sites still compare against `'Task'` only, so subagent rendering never triggers.

**Files:**
- Create: `src/components/chat/utils/subagentToolNames.ts`
- Create: `src/components/chat/utils/subagentToolNames.test.ts`
- Modify: `src/components/chat/hooks/useChatMessages.ts:146`
- Modify: `src/components/chat/tools/ToolRenderer.tsx:43`
- Modify: `src/components/chat/tools/configs/toolConfigs.ts` (`getToolConfig`, line ~555)

**Interfaces:**
- Produces: `isSubagentToolName(toolName: string | undefined): boolean` and `SUBAGENT_TOOL_NAMES: ReadonlySet<string>` from `src/components/chat/utils/subagentToolNames.ts`. Tasks 4, 5, 8 import `isSubagentToolName`.

- [ ] **Step 1: Write the failing test**

```ts
// src/components/chat/utils/subagentToolNames.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { isSubagentToolName, SUBAGENT_TOOL_NAMES } from './subagentToolNames.ts';

test('recognizes the current Agent tool name', () => {
  assert.equal(isSubagentToolName('Agent'), true);
});

test('recognizes the legacy Task tool name', () => {
  assert.equal(isSubagentToolName('Task'), true);
});

test('rejects other tools and empty input', () => {
  assert.equal(isSubagentToolName('Bash'), false);
  assert.equal(isSubagentToolName('TaskCreate'), false);
  assert.equal(isSubagentToolName(undefined), false);
  assert.equal(isSubagentToolName(''), false);
});

test('set contains exactly the two known names', () => {
  assert.deepEqual([...SUBAGENT_TOOL_NAMES].sort(), ['Agent', 'Task']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/components/chat/utils/subagentToolNames.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write the helper**

```ts
// src/components/chat/utils/subagentToolNames.ts
/**
 * Claude Code renamed its subagent-dispatch tool from `Task` to `Agent`.
 * Official agent-sdk docs recommend matching both names for compatibility;
 * old persisted transcripts still carry `Task`.
 */
export const SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set(['Agent', 'Task']);

export function isSubagentToolName(toolName: string | undefined): boolean {
  return typeof toolName === 'string' && SUBAGENT_TOOL_NAMES.has(toolName);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/components/chat/utils/subagentToolNames.test.ts`
Expected: 4 pass.

- [ ] **Step 5: Fix the three call sites**

In `src/components/chat/hooks/useChatMessages.ts` (line 146), add the import and replace:

```ts
import { isSubagentToolName } from '../utils/subagentToolNames';
// was: const isSubagentContainer = msg.toolName === 'Task';
const isSubagentContainer = isSubagentToolName(msg.toolName);
```

In `src/components/chat/tools/ToolRenderer.tsx` (line 43, inside `getToolCategory`), add the import and replace:

```ts
import { isSubagentToolName } from '../utils/subagentToolNames';
// was: if (toolName === 'Task') return 'agent';
if (isSubagentToolName(toolName)) return 'agent';
```

Note: keep the `TaskCreate/TaskUpdate/TaskList/TaskGet → 'task'` line ABOVE this check exactly where it is — those are different tools and must not match.

In `src/components/chat/tools/configs/toolConfigs.ts`, keep the `Task:` config object as-is and alias it in `getToolConfig` (line ~555):

```ts
export function getToolConfig(toolName: string): ToolDisplayConfig {
  // 'Agent' is the current name of the subagent-dispatch tool; 'Task' is the
  // legacy name still present in old transcripts. Same rendering config.
  if (toolName === 'Agent') {
    return TOOL_CONFIGS.Task;
  }
  return TOOL_CONFIGS[toolName] || TOOL_CONFIGS.Default;
}
```

- [ ] **Step 6: Typecheck and lint**

Run: `npm run typecheck && npx eslint src/components/chat/utils/subagentToolNames.ts src/components/chat/hooks/useChatMessages.ts src/components/chat/tools/ToolRenderer.tsx src/components/chat/tools/configs/toolConfigs.ts`
Expected: both clean.

- [ ] **Step 7: Commit**

```bash
git add src/components/chat/utils/subagentToolNames.ts src/components/chat/utils/subagentToolNames.test.ts src/components/chat/hooks/useChatMessages.ts src/components/chat/tools/ToolRenderer.tsx src/components/chat/tools/configs/toolConfigs.ts
git commit -m "fix(chat): recognize Agent as the subagent dispatch tool name"
```

---

### Task 2: Server env vars, `Agent` allowlist, and `forkSession` passthrough

`mapCliOptionsToSDK` (exported from `server/claude-sdk.js:837`) builds the SDK options for every Claude run. Three additions, all spec §5/§8: always-on `CLAUDE_CODE_FORK_SUBAGENT=1` + `CLAUDE_CODE_FORWARD_SUBAGENT_TEXT=1` env vars, `Agent`/`Task` in `allowedTools`, and a `forkSession` option passthrough (consumed by Task 6).

**Files:**
- Create: `server/tests/claude-sdk-options.test.js`
- Modify: `server/claude-sdk.js` (`mapCliOptionsToSDK`, lines ~160-238)

**Interfaces:**
- Consumes: `mapCliOptionsToSDK(options)` — already exported.
- Produces: `mapCliOptionsToSDK` now honors `options.forkSession: boolean` → `sdkOptions.forkSession`; always sets the two env vars and includes `'Agent'`/`'Task'` in `sdkOptions.allowedTools`. Task 6 relies on `forkSession`.

- [ ] **Step 1: Write the failing test**

```js
// server/tests/claude-sdk-options.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mapCliOptionsToSDK } from '../claude-sdk.js';

test('always enables fork-subagent and subagent-text-forwarding env vars', () => {
  const sdkOptions = mapCliOptionsToSDK({});
  assert.equal(sdkOptions.env.CLAUDE_CODE_FORK_SUBAGENT, '1');
  assert.equal(sdkOptions.env.CLAUDE_CODE_FORWARD_SUBAGENT_TEXT, '1');
});

test('always allowlists the subagent dispatch tool (both names)', () => {
  const sdkOptions = mapCliOptionsToSDK({});
  assert.ok(sdkOptions.allowedTools.includes('Agent'));
  assert.ok(sdkOptions.allowedTools.includes('Task'));
});

test('does not duplicate Agent when user already allowlisted it', () => {
  const sdkOptions = mapCliOptionsToSDK({
    toolsSettings: { allowedTools: ['Agent', 'Bash'], disallowedTools: [], skipPermissions: false },
  });
  assert.equal(sdkOptions.allowedTools.filter((t) => t === 'Agent').length, 1);
  assert.ok(sdkOptions.allowedTools.includes('Bash'));
});

test('passes forkSession through when requested', () => {
  assert.equal(mapCliOptionsToSDK({ forkSession: true }).forkSession, true);
  assert.equal('forkSession' in mapCliOptionsToSDK({}), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test --tsconfig server/tsconfig.json server/tests/claude-sdk-options.test.js`
Expected: FAIL — env vars undefined, `Agent` missing, `forkSession` missing. (If the import itself fails on side effects, check what `claude-sdk.js` imports at module load — it reads env/config only, no server start; this pattern already works for other legacy-file tests.)

- [ ] **Step 3: Implement in `mapCliOptionsToSDK`**

In `server/claude-sdk.js`, after `sdkOptions.env = { ...process.env };` (line ~167) add:

```js
  // Spec 2026-07-22-subagent-fork-subtask: always-on subagent capabilities.
  // FORK_SUBAGENT lets Claude request subagent_type "fork" (inherited-context
  // subagent, the /subtask mechanism). FORWARD_SUBAGENT_TEXT makes the CLI
  // emit subagent text/thinking blocks so the transcript panel can show them.
  sdkOptions.env.CLAUDE_CODE_FORK_SUBAGENT = '1';
  sdkOptions.env.CLAUDE_CODE_FORWARD_SUBAGENT_TEXT = '1';
```

After the `allowedTools` array is finalized but before `sdkOptions.allowedTools = allowedTools;` (line ~202), add:

```js
  // Auto-approve subagent DISPATCH only (the act of starting a subagent).
  // Tools the subagent itself calls still go through the normal approval
  // flow — this does not widen the tools-disabled-by-default policy.
  for (const dispatchTool of ['Agent', 'Task']) {
    if (!allowedTools.includes(dispatchTool)) {
      allowedTools.push(dispatchTool);
    }
  }
```

After `if (sessionId) { sdkOptions.resume = sessionId; }` (line ~235) add:

```js
  // /fork: resume an existing provider session but branch into a new session
  // id instead of appending to it. Set by the websocket /fork interception.
  if (options.forkSession) {
    sdkOptions.forkSession = true;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test --tsconfig server/tsconfig.json server/tests/claude-sdk-options.test.js`
Expected: 4 pass.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
npm run typecheck && npx eslint server/claude-sdk.js
git add server/claude-sdk.js server/tests/claude-sdk-options.test.js
git commit -m "feat(server): enable fork subagents, forward subagent text, allowlist Agent dispatch"
```

---

### Task 3: Persisted path — fix agent-file discovery and stamp `parentToolUseId`

The persisted JSONL reader looks for `agent-*.jsonl` with a flat `readdir` of the project dir, but Claude Code stores them at `<projectDir>/<provider-session-id>/subagents/agent-<agentId>.jsonl` — so it never finds any. Fix discovery, then replace the `subagentTools` aggregate with individually emitted child messages stamped with `parentToolUseId` (the data contract Task 4 consumes). On disk the linkage is: the user-side record whose `message.content[]` has a `tool_result` also carries `toolUseResult.agentId`; that `tool_result.tool_use_id` IS the parent Agent tool_use id.

**Files:**
- Create: `server/modules/providers/tests/claude-sessions-subagent.test.ts`
- Modify: `server/modules/providers/list/claude/claude-sessions.provider.ts` (`parseAgentTools` → `parseAgentEntries`, `getSessionMessages` lines ~151-210, `fetchHistory` lines ~658-680; remove `subagentTools` at lines 48, 206, 379, 651, 678)
- Modify: `server/shared/types.ts:277` (remove `subagentTools?: unknown;`)

**Interfaces:**
- Consumes: `sessionsDb.getSessionById(sessionId)?.jsonl_path` (existing).
- Produces: `fetchHistory` results now interleave subagent-child `NormalizedMessage`s, each with `parentToolUseId: string` set to the parent Agent tool_use's `toolId`. The `subagentTools` field no longer exists anywhere server-side.

- [ ] **Step 1: Write the failing test**

Follow the fixture pattern of `server/modules/providers/tests/codex-sessions.test.ts` (mkdtemp + `DATABASE_PATH` env). Key content:

```ts
// server/modules/providers/tests/claude-sessions-subagent.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

process.env.DATABASE_PATH = path.join(os.tmpdir(), `claude-subagent-test-${process.pid}.db`);

const { sessionsDb } = await import('@/modules/database/index.js');
const { ClaudeSessionsProvider } = await import('@/modules/providers/list/claude/claude-sessions.provider.js');

const PROVIDER_SESSION_ID = '11111111-1111-1111-1111-111111111111';
const AGENT_ID = 'abc123def456';
const PARENT_TOOL_ID = 'toolu_parent01';

function jsonlLine(obj: Record<string, unknown>): string {
  return `${JSON.stringify(obj)}\n`;
}

test('fetchHistory stamps parentToolUseId onto subagent child messages', async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), 'claude-proj-'));
  try {
    const mainJsonl = path.join(projectDir, `${PROVIDER_SESSION_ID}.jsonl`);
    // Parent: assistant Agent tool_use, then user tool_result carrying toolUseResult.agentId
    await writeFile(mainJsonl, [
      jsonlLine({
        sessionId: PROVIDER_SESSION_ID, timestamp: '2026-07-22T10:00:00Z', type: 'assistant',
        message: { role: 'assistant', content: [
          { type: 'tool_use', id: PARENT_TOOL_ID, name: 'Agent',
            input: { description: 'Review readme', subagent_type: 'general-purpose', prompt: 'Review the readme' } },
        ] },
      }),
      jsonlLine({
        sessionId: PROVIDER_SESSION_ID, timestamp: '2026-07-22T10:01:00Z', type: 'user',
        toolUseResult: { agentId: AGENT_ID },
        message: { role: 'user', content: [
          { type: 'tool_result', tool_use_id: PARENT_TOOL_ID, content: 'Report: looks fine' },
        ] },
      }),
    ].join(''));

    // Child transcript at the REAL nested location
    const subagentsDir = path.join(projectDir, PROVIDER_SESSION_ID, 'subagents');
    await mkdir(subagentsDir, { recursive: true });
    await writeFile(path.join(subagentsDir, `agent-${AGENT_ID}.jsonl`), [
      jsonlLine({
        timestamp: '2026-07-22T10:00:10Z', type: 'assistant',
        message: { role: 'assistant', content: [
          { type: 'text', text: 'Reading the readme now.' },
          { type: 'tool_use', id: 'toolu_child01', name: 'Read', input: { file_path: '/tmp/README.md' } },
        ] },
      }),
      jsonlLine({
        timestamp: '2026-07-22T10:00:20Z', type: 'user',
        message: { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'toolu_child01', content: '# README' },
        ] },
      }),
    ].join(''));

    const appSessionId = sessionsDb.createSession(
      PROVIDER_SESSION_ID, 'claude', projectDir, undefined, undefined, undefined, mainJsonl,
    );

    const provider = new ClaudeSessionsProvider();
    const result = await provider.fetchHistory(appSessionId, {
      providerSessionId: PROVIDER_SESSION_ID, limit: null, offset: 0,
    });

    const children = result.messages.filter((m) => m.parentToolUseId === PARENT_TOOL_ID);
    // Child text + child tool_use at minimum (tool_result attaches to tool_use downstream)
    assert.ok(children.length >= 2, `expected stamped children, got ${children.length}`);
    const childToolUse = children.find((m) => m.kind === 'tool_use');
    assert.equal(childToolUse?.toolName, 'Read');
    const childText = children.find((m) => m.kind === 'text');
    assert.equal(childText?.content, 'Reading the readme now.');

    // Parent Agent tool_use is top-level (no parentToolUseId) and has no subagentTools field
    const parent = result.messages.find((m) => m.toolId === PARENT_TOOL_ID);
    assert.ok(parent);
    assert.equal(parent.parentToolUseId, undefined);
    assert.equal('subagentTools' in parent, false);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test --tsconfig server/tsconfig.json server/modules/providers/tests/claude-sessions-subagent.test.ts`
Expected: FAIL — no children found (discovery bug means the agent file is never read).

- [ ] **Step 3: Implement in `claude-sessions.provider.ts`**

3a. Rename/replace `parseAgentTools` with `parseAgentEntries` — same JSONL line-reader skeleton, but return the **raw entries** (each parsed line object) instead of a tools array:

```ts
async function parseAgentEntries(filePath: string): Promise<AnyRecord[]> {
  const entries: AnyRecord[] = [];
  try {
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as AnyRecord);
      } catch {
        // Skip malformed lines from concurrent writes.
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Error parsing agent file ${filePath}:`, message);
  }
  return entries;
}
```

3b. In `getSessionMessages` (lines ~151-210): delete the flat `readdir`/`agentFiles` block. After the main-file read loop, build an `agentId → parentToolUseId` map and merge stamped child entries into `messages`:

```ts
    // Map each subagent to its parent Agent tool_use id. The user-side record
    // that carries toolUseResult.agentId also holds the tool_result whose
    // tool_use_id IS the parent tool_use id (parent_tool_use_id itself is
    // never persisted to disk).
    const agentParentToolIds = new Map<string, string>();
    for (const message of messages) {
      const agentId = message.toolUseResult?.agentId;
      if (!agentId || !Array.isArray(message.message?.content)) continue;
      for (const part of message.message.content as AnyRecord[]) {
        if (part.type === 'tool_result' && part.tool_use_id) {
          agentParentToolIds.set(String(agentId), String(part.tool_use_id));
          break;
        }
      }
    }

    // Agent transcripts live at <projectDir>/<provider-session-id>/subagents/.
    const subagentsDir = path.join(projectDir, providerSessionId, 'subagents');
    for (const [agentId, parentToolUseId] of agentParentToolIds) {
      const agentFilePath = path.join(subagentsDir, `agent-${agentId}.jsonl`);
      const entries = await parseAgentEntries(agentFilePath);
      for (const entry of entries) {
        // Non-enumerable-safe internal marker; consumed by fetchHistory below.
        entry.__parentToolUseId = parentToolUseId;
        messages.push(entry);
      }
    }
```

Delete the old `agentToolsCache` loop and the `message.subagentTools = agentTools;` assignment (line ~206). Keep the chronological sort that follows — it interleaves child entries by timestamp.

3c. In `fetchHistory`'s normalize loop (line ~660), propagate the marker onto every normalized output of a stamped raw entry:

```ts
    const normalized: NormalizedMessage[] = [];
    for (const raw of rawMessages) {
      const produced = this.normalizeMessage(raw, sessionId);
      if (typeof raw.__parentToolUseId === 'string') {
        for (const msg of produced) {
          msg.parentToolUseId = raw.__parentToolUseId;
        }
      }
      normalized.push(...produced);
    }
```

3d. Remove every `subagentTools` reference in this file: the type field at line 48, the passthroughs at lines ~379 and ~651, and `msg.subagentTools = toolResult.subagentTools;` at line ~678. Also remove `subagentTools?: unknown;` from `server/shared/types.ts:277`. Check `parentToolUseId` exists on the server `NormalizedMessage` type in `server/shared/types.ts` — if absent, add `parentToolUseId?: string;` next to where `subagentTools` was.

- [ ] **Step 4: Run tests**

Run: `npx tsx --test --tsconfig server/tsconfig.json server/modules/providers/tests/claude-sessions-subagent.test.ts`
Expected: PASS.
Also run the existing provider tests to catch regressions: `npx tsx --test --tsconfig server/tsconfig.json server/modules/providers/tests/*.test.ts`
Expected: all pass.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
npm run typecheck && npx eslint server/modules/providers/list/claude/claude-sessions.provider.ts server/shared/types.ts
git add -A server/modules/providers server/shared/types.ts
git commit -m "fix(server): resolve subagent transcripts at their real path and stamp parentToolUseId"
```

---

### Task 4: Client-side grouping pass in `normalizedToChatMessages`

One grouping algorithm for live and persisted data: partition messages by `parentToolUseId`, nest children under their parent Agent tool_use, build `subagentState` from the scan. This also suppresses the synthetic "user" bubble (a subagent's delegation prompt arrives as `role:'user'` WITH `parentToolUseId` — partitioning removes it from top level automatically).

**Files:**
- Create: `src/components/chat/hooks/useChatMessages.test.ts`
- Modify: `src/components/chat/hooks/useChatMessages.ts` (grouping in `normalizedToChatMessages`; delete the `msg.subagentTools` consumption at lines ~148-160)
- Modify: `src/components/chat/types/types.ts` (extend `subagentState` with `childMessages: ChatMessage[]`)
- Modify: `src/stores/useSessionStore.ts:82` (delete `subagentTools?: unknown[];` — `parentToolUseId?: string` already exists at line 81)

**Interfaces:**
- Consumes: `isSubagentToolName` (Task 1); `NormalizedMessage.parentToolUseId` (Task 3 for persisted, `claude-sdk.js:286-290` for live).
- Produces: `ChatMessage.subagentState` gains `childMessages: ChatMessage[]` (full converted child transcript, ordered). `childTools: SubagentChildTool[]` keeps its existing shape (tool entries only, results attached). Tasks 5 and 8 consume both.

- [ ] **Step 1: Write the failing test**

```ts
// src/components/chat/hooks/useChatMessages.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizedToChatMessages } from './useChatMessages.ts';
import type { NormalizedMessage } from '../../../stores/useSessionStore.ts';

const base = { sessionId: 's1', provider: 'claude' as const, timestamp: '2026-07-22T10:00:00Z' };

function subagentFixture(): NormalizedMessage[] {
  return [
    { ...base, id: 'm1', kind: 'tool_use', toolName: 'Agent', toolId: 'toolu_p',
      toolInput: JSON.stringify({ description: 'Review readme', subagent_type: 'general-purpose', prompt: 'go' }) },
    { ...base, id: 'm2', kind: 'text', role: 'user', content: 'delegation prompt text', parentToolUseId: 'toolu_p' },
    { ...base, id: 'm3', kind: 'tool_use', toolName: 'Read', toolId: 'toolu_c1',
      toolInput: '{"file_path":"/tmp/README.md"}', parentToolUseId: 'toolu_p' },
    { ...base, id: 'm4', kind: 'tool_result', toolId: 'toolu_c1', content: '# README', parentToolUseId: 'toolu_p' },
    { ...base, id: 'm5', kind: 'text', role: 'assistant', content: 'Looks fine.', parentToolUseId: 'toolu_p' },
    { ...base, id: 'm6', kind: 'tool_result', toolId: 'toolu_p', content: 'Report: fine' },
  ] as NormalizedMessage[];
}

test('children nest under the Agent container, not top level', () => {
  const out = normalizedToChatMessages(subagentFixture());
  const containers = out.filter((m) => m.isSubagentContainer);
  assert.equal(containers.length, 1);
  // Nothing with a parent renders top-level: no fake user bubble, no stray Read
  assert.equal(out.some((m) => m.type === 'user'), false);
  assert.equal(out.some((m) => m.toolName === 'Read'), false);
});

test('subagentState carries tools and the full child transcript', () => {
  const out = normalizedToChatMessages(subagentFixture());
  const container = out.find((m) => m.isSubagentContainer);
  assert.ok(container?.subagentState);
  assert.equal(container.subagentState.childTools.length, 1);
  assert.equal(container.subagentState.childTools[0].toolName, 'Read');
  assert.equal(container.subagentState.childTools[0].toolResult?.content, '# README');
  assert.equal(container.subagentState.isComplete, true);
  // childMessages: delegation text + Read tool + assistant text (order preserved)
  const kinds = container.subagentState.childMessages.map((m) => m.isToolUse ? 'tool' : m.type);
  assert.deepEqual(kinds, ['user', 'tool', 'assistant']);
});

test('running subagent (no parent result) reports isComplete=false', () => {
  const msgs = subagentFixture().filter((m) => m.id !== 'm6');
  const container = normalizedToChatMessages(msgs).find((m) => m.isSubagentContainer);
  assert.equal(container?.subagentState?.isComplete, false);
});

test('legacy Task tool name still groups', () => {
  const msgs = subagentFixture();
  (msgs[0] as { toolName?: string }).toolName = 'Task';
  const container = normalizedToChatMessages(msgs).find((m) => m.isSubagentContainer);
  assert.ok(container);
});

test('orphan children (parent trimmed out of window) are dropped, not top-leveled', () => {
  const out = normalizedToChatMessages(subagentFixture().slice(1, 5));
  assert.equal(out.some((m) => m.type === 'user'), false);
  assert.equal(out.some((m) => m.toolName === 'Read'), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/components/chat/hooks/useChatMessages.test.ts`
Expected: FAIL — children currently render top-level; `childMessages` doesn't exist. (If the import chain pulls in something node can't load, check `useChatMessages.ts` imports — they are types + pure `chatFormatting` utils, which load fine under tsx.)

- [ ] **Step 3: Implement grouping**

3a. In `src/components/chat/types/types.ts`, extend the subagent state (both in `ChatMessage` at line ~60 and the mirrored inline type in `ToolRenderer.tsx` props):

```ts
  subagentState?: {
    childTools: SubagentChildTool[];
    childMessages: ChatMessage[];
    currentToolIndex: number;
    isComplete: boolean;
  };
```

3b. In `normalizedToChatMessages` (`useChatMessages.ts`), at the top of the function, partition:

```ts
  // Group subagent children under their parent. `parentToolUseId` is the one
  // data contract both delivery paths honor: the live SDK stream sets it in
  // claude-sdk.js, the persisted reader stamps it during JSONL reconstruction.
  const childrenByParent = new Map<string, NormalizedMessage[]>();
  const topLevel: NormalizedMessage[] = [];
  for (const msg of messages) {
    if (typeof msg.parentToolUseId === 'string' && msg.parentToolUseId) {
      const siblings = childrenByParent.get(msg.parentToolUseId) ?? [];
      siblings.push(msg);
      childrenByParent.set(msg.parentToolUseId, siblings);
    } else {
      topLevel.push(msg);
    }
  }
```

Iterate `topLevel` (not `messages`) in the existing main loop. Orphaned children (parent not in the loaded window) are dropped by construction — same policy the file already applies to orphan tool_results.

3c. In the `case 'tool_use':` branch, replace the `msg.subagentTools` consumption (lines ~148-160) with derivation from `childrenByParent`:

```ts
        const children = (msg.toolId && childrenByParent.get(msg.toolId)) || [];
        const childTools: SubagentChildTool[] = [];
        if (isSubagentContainer && children.length > 0) {
          const childResults = new Map<string, NormalizedMessage>();
          for (const child of children) {
            if (child.kind === 'tool_result' && child.toolId) childResults.set(child.toolId, child);
          }
          for (const child of children) {
            if (child.kind !== 'tool_use' || !child.toolId) continue;
            const childResult = childResults.get(child.toolId);
            childTools.push({
              toolId: child.toolId,
              toolName: child.toolName || 'UnknownTool',
              toolInput: child.toolInput,
              toolResult: childResult
                ? { content: formatToolResultContent(childResult.content), isError: Boolean(childResult.isError) }
                : null,
              timestamp: new Date(child.timestamp || Date.now()),
            });
          }
        }
        // Full child transcript for the drawer: recursion handles nested
        // subagents (a child Agent call groups its own children one level down).
        const childMessages = isSubagentContainer && children.length > 0
          ? normalizedToChatMessages(children.map((c) => ({ ...c, parentToolUseId: undefined })))
          : [];
```

Note the `parentToolUseId: undefined` strip in the recursive call: within the parent's own transcript the direct children ARE the top level. Grand-children (from a nested subagent) keep their own deeper parent id — but only after re-stamping: strip ONLY ids equal to this parent's `toolId`, not all ids. Use:

```ts
          ? normalizedToChatMessages(children.map((c) =>
              c.parentToolUseId === msg.toolId ? { ...c, parentToolUseId: undefined } : c))
          : [];
```

(All direct children satisfy that equality by construction of the map; the guard documents intent and keeps deeper nesting correct if the SDK ever emits mixed-depth parents in one list.)

Set `subagentState` with the new field:

```ts
          subagentState: isSubagentContainer
            ? {
                childTools,
                childMessages,
                currentToolIndex: childTools.length > 0 ? childTools.length - 1 : -1,
                isComplete: Boolean(toolResult),
              }
            : undefined,
```

3d. Delete `subagentTools?: unknown[];` from `src/stores/useSessionStore.ts:82` and fix any remaining references (`grep -rn subagentTools src/ server/` must return zero code hits — comments/docs are fine to update or remove).

- [ ] **Step 4: Run tests**

Run: `npx tsx --test src/components/chat/hooks/useChatMessages.test.ts src/components/chat/utils/subagentToolNames.test.ts`
Expected: all pass.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
npm run typecheck && npx eslint src/components/chat/hooks/useChatMessages.ts src/components/chat/types/types.ts src/stores/useSessionStore.ts src/components/chat/tools/ToolRenderer.tsx
git add -A src/components/chat src/stores/useSessionStore.ts
git commit -m "feat(chat): group subagent children by parentToolUseId in one client-side pass"
```

---

### Task 5: SubagentTranscriptPanel drawer

Replace the inline one-liner expansion with a slide-over drawer showing the subagent's full transcript, rendered through the existing `ToolRenderer` pipeline. The collapsed block keeps the live "Currently: …" indicator.

**Files:**
- Create: `src/components/chat/tools/components/SubagentTranscriptPanel.tsx`
- Modify: `src/components/chat/tools/components/SubagentContainer.tsx`
- Modify: `src/components/chat/tools/components/index.ts` (export the new component)

**Interfaces:**
- Consumes: `subagentState.childMessages: ChatMessage[]` and `subagentState.childTools` (Task 4); `ToolRenderer` with props `{ toolName, toolInput, toolResult, toolId, mode }` (existing, `ToolRenderer.tsx:18-35`); `MarkdownContent` from `./ContentRenderers` (already exported via `./components` barrel).
- Produces: `SubagentTranscriptPanel` component with props `{ open: boolean; onClose: () => void; title: string; prompt: string; childMessages: ChatMessage[]; isComplete: boolean; finalResult: string | null }`.

- [ ] **Step 1: Build the panel component**

```tsx
// src/components/chat/tools/components/SubagentTranscriptPanel.tsx
import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type { ChatMessage } from '../../types/types';
import ToolRenderer from '../ToolRenderer';
import { MarkdownContent } from './ContentRenderers';

interface SubagentTranscriptPanelProps {
  open: boolean;
  onClose: () => void;
  title: string;
  prompt: string;
  childMessages: ChatMessage[];
  isComplete: boolean;
  finalResult: string | null;
}

/**
 * Slide-over drawer showing a subagent's full transcript at main-session
 * fidelity. Read-only, live-updating (childMessages re-derive on every store
 * change while the run streams). Deliberately NOT a route: closing it must
 * return to the exact main-session scroll position.
 */
export const SubagentTranscriptPanel: React.FC<SubagentTranscriptPanelProps> = ({
  open, onClose, title, prompt, childMessages, isComplete, finalResult,
}) => {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[1100]" role="dialog" aria-label={title}>
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="absolute bottom-0 right-0 top-0 flex w-full max-w-2xl flex-col border-l border-border bg-background shadow-2xl">
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-foreground">{title}</div>
            <div className="text-xs text-muted-foreground">
              {isComplete ? 'Completed' : 'Running…'}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Close subagent transcript"
          >
            <X size={14} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {prompt && (
            <div className="mb-3 rounded-md border border-border bg-muted/40 p-2 text-xs">
              <div className="mb-1 font-semibold uppercase tracking-wide text-muted-foreground">Task</div>
              <div className="whitespace-pre-wrap break-words">{prompt}</div>
            </div>
          )}
          {childMessages.map((message, index) => {
            if (message.isToolUse) {
              return (
                <div key={message.toolId || index} className="my-1">
                  <ToolRenderer
                    toolName={message.toolName || 'UnknownTool'}
                    toolInput={message.toolInput}
                    toolResult={message.toolResult}
                    toolId={message.toolId}
                    mode="input"
                  />
                </div>
              );
            }
            return (
              <div
                key={index}
                className={`my-2 text-sm ${message.type === 'user' ? 'text-muted-foreground' : 'text-foreground'}`}
              >
                <MarkdownContent content={message.content || ''} />
              </div>
            );
          })}
          {isComplete && finalResult && (
            <div className="mt-3 rounded-md border border-green-500/30 bg-green-500/5 p-2 text-xs">
              <div className="mb-1 font-semibold uppercase tracking-wide text-green-600 dark:text-green-400">Result</div>
              <MarkdownContent content={finalResult} />
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
};
```

Adjust the `MarkdownContent` import to its actual export location if the barrel path differs (check `src/components/chat/tools/components/index.ts`) and match `ToolRenderer`'s actual required props if the interface asks for more (it currently requires `toolName`, `toolInput`, `mode`).

- [ ] **Step 2: Wire it into `SubagentContainer.tsx`**

Rework `SubagentContainer` to: keep the collapsed one-line header + live "Currently: …" indicator exactly as-is; remove the inline `CollapsibleSection`/tool-history/`line-clamp-6` body; clicking the header (or a "View transcript" affordance) sets local `open` state and renders the panel:

```tsx
const [transcriptOpen, setTranscriptOpen] = useState(false);
// header row onClick={() => setTranscriptOpen(true)}
<SubagentTranscriptPanel
  open={transcriptOpen}
  onClose={() => setTranscriptOpen(false)}
  title={title}
  prompt={prompt}
  childMessages={subagentState.childMessages}
  isComplete={isComplete}
  finalResult={/* reuse the existing toolResult text-extraction logic (lines 139-166), extracted into a small function */}
/>
```

Extract the existing result-content parsing IIFE (lines ~139-166) into a top-level helper `extractResultText(toolResult): string | null` in the same file and use it both for the panel's `finalResult` and (trimmed) for the collapsed completion line. Delete `getCompactToolDisplay` usages that the removed inline body no longer needs (keep it if the "Currently:" line still uses it — it does; keep the function).

- [ ] **Step 3: Manual verification**

Run `npm run dev`, open a Claude session, send a prompt that dispatches a subagent (e.g. "use a subagent to summarize README.md"). Verify: collapsed purple block appears with live "Currently: …" updates; clicking opens the drawer; drawer shows delegation prompt, each tool call via the standard renderers, subagent text between tools (requires Task 2's env var — restart the dev server backend first, it does not hot-reload); Esc/overlay-click closes and main scroll position is preserved; after completion, reload the page and confirm the drawer shows the identical transcript from persisted data.

- [ ] **Step 4: Typecheck, lint, commit**

```bash
npm run typecheck && npx eslint src/components/chat/tools/components/SubagentTranscriptPanel.tsx src/components/chat/tools/components/SubagentContainer.tsx
git add src/components/chat/tools/components/
git commit -m "feat(chat): full-transcript slide-over drawer for subagent runs"
```

---

### Task 6: `/fork` interception in the WebSocket chat handler

`/fork` is not SDK-dispatchable (verified: absent from `system/init.slash_commands`). Intercept it in `handleChatSend`, allocate a fresh app session, and run the query against the NEW session with `forkSession: true` + resume of the OLD provider id. The existing `session_created` capture in `chat-session-writer.service.ts:83-95` maps the fork's announced provider id onto the new row with no extra work. The user stays on the original session; the fork appears in the sidebar.

**Files:**
- Create: `server/modules/websocket/tests/fork-command.test.ts`
- Modify: `server/modules/websocket/services/chat-websocket.service.ts` (`handleChatSend`, lines ~141-222)

**Interfaces:**
- Consumes: `sessionsService.createAppSession(provider, projectPath)` (`server/modules/providers` barrel); `sessionsDb.updateSessionCustomName(sessionId, customName)` (`sessions.db.ts:214`); `mapCliOptionsToSDK` honoring `forkSession` (Task 2); `createNormalizedMessage` from `@/shared/utils.js`.
- Produces: exported pure helper `parseForkCommand(content: string): { prompt: string } | null` (exported for tests from the service file).

- [ ] **Step 1: Write the failing test for the pure parser**

```ts
// server/modules/websocket/tests/fork-command.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseForkCommand, parseSubtaskCommand } from '../services/chat-websocket.service.js';

test('parses /fork with and without a prompt', () => {
  assert.deepEqual(parseForkCommand('/fork'), { prompt: '' });
  assert.deepEqual(parseForkCommand('/fork open a draft PR'), { prompt: 'open a draft PR' });
  assert.deepEqual(parseForkCommand('  /fork   spaced  '), { prompt: 'spaced' });
});

test('rejects non-fork input', () => {
  assert.equal(parseForkCommand('/forked'), null);
  assert.equal(parseForkCommand('tell me about /fork'), null);
  assert.equal(parseForkCommand('/subtask x'), null);
});

test('parses /subtask task text', () => {
  assert.deepEqual(parseSubtaskCommand('/subtask review the readme'), { task: 'review the readme' });
  assert.equal(parseSubtaskCommand('/subtask'), null); // task text required
  assert.equal(parseSubtaskCommand('/subtasks x'), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test --tsconfig server/tsconfig.json server/modules/websocket/tests/fork-command.test.ts`
Expected: FAIL (functions not exported).

- [ ] **Step 3: Implement the parsers (this task implements both; Task 7 wires `/subtask`)**

In `chat-websocket.service.ts`, above `handleChatSend`:

```ts
/** Matches "/fork" or "/fork <prompt>" typed as the whole message. */
export function parseForkCommand(content: string): { prompt: string } | null {
  const match = content.trim().match(/^\/fork(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  return { prompt: (match[1] ?? '').trim() };
}

/** Matches "/subtask <task>" typed as the whole message (task text required). */
export function parseSubtaskCommand(content: string): { task: string } | null {
  const match = content.trim().match(/^\/subtask\s+([\s\S]+)$/);
  if (!match) return null;
  const task = match[1].trim();
  return task ? { task } : null;
}
```

- [ ] **Step 4: Run parser tests**

Run: `npx tsx --test --tsconfig server/tsconfig.json server/modules/websocket/tests/fork-command.test.ts`
Expected: all pass.

- [ ] **Step 5: Wire `/fork` into `handleChatSend`**

In `handleChatSend`, right after the `spawnFn` resolution (line ~171) and BEFORE `chatRunRegistry.startRun`, insert:

```ts
  const forkCommand = provider === 'claude' ? parseForkCommand(typeof data.content === 'string' ? data.content : '') : null;
  if (forkCommand) {
    if (!session.provider_session_id) {
      sendProtocolError(ws, 'FORK_NO_HISTORY', 'Cannot fork a session that has no conversation yet.', sessionId);
      return;
    }

    // Allocate the fork its own app session row; the SDK announces the fork's
    // provider id mid-run and the session writer maps it onto this row.
    const forked = sessionsService.createAppSession('claude', session.project_path ?? '');
    sessionsDb.updateSessionCustomName(
      forked.sessionId,
      `${session.custom_name || 'Session'} (fork)`,
    );

    const forkRun = chatRunRegistry.startRun({
      appSessionId: forked.sessionId,
      provider,
      providerSessionId: session.provider_session_id,
      connection: ws,
      userId,
    });
    if (!forkRun) {
      sendProtocolError(ws, 'RUN_IN_PROGRESS', `Forked session "${forked.sessionId}" already has a run in progress.`, sessionId);
      return;
    }

    // Ack into the ORIGINAL session's transcript so the user sees where the fork went.
    ws.send(JSON.stringify(createNormalizedMessage({
      kind: 'task_notification',
      sessionId,
      provider,
      status: 'completed',
      summary: `Forked conversation into a new session${forkCommand.prompt ? ' and started it on the given prompt' : ''}. Find it in the sidebar as "${session.custom_name || 'Session'} (fork)".`,
    })));

    const clientOptions = (data.options ?? {}) as AnyRecord;
    const forkOptions: AnyRecord = {
      ...clientOptions,
      images: [],
      sessionId: session.provider_session_id,
      resume: true,
      forkSession: true,
      cwd: session.project_path ?? undefined,
      projectPath: session.project_path ?? undefined,
    };

    try {
      await spawnFn(
        forkCommand.prompt || 'Continue from where the conversation left off. Wait for further instructions and summarize the current state briefly.',
        forkOptions,
        forkRun.writer,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[Chat] /fork run failed', { sessionId: forked.sessionId, error: message });
    } finally {
      chatRunRegistry.completeRunIfCurrent(forkRun, { exitCode: 1 });
    }
    return;
  }
```

Add the needed imports at the top of the file (respect the module barrel rule): `sessionsService` is already available if the file imports from `@/modules/providers/index.js` — check existing imports first; `createNormalizedMessage` from `@/shared/utils.js`; `sessionsDb` is already imported (used at line ~154).

Note on the empty-prompt default: the SDK `query()` requires a prompt; the CLI's `/fork` without a prompt parks the copy in agent view awaiting input, which has no equivalent here — a neutral "summarize current state" prompt is the closest match and gives the forked session a first turn the user can pick up from. The frontend composer needs NO change: `/fork` isn't in `slashCommands`, so `handleSubmit` falls through to a normal `chat.send` with the raw text (verified behavior; also consistent with the command-palette spec's claude-builtin fall-through dispatch).

- [ ] **Step 6: Manual verification**

Restart the backend (`npm run server:dev` is not watch mode). In a Claude session with history, type `/fork say what files we discussed`. Verify: a `task_notification` row appears in the current chat; a new session named "<name> (fork)" appears in the sidebar (may take a beat — sessions-watcher picks up the new JSONL); opening it shows the inherited history plus the new turn; the original session is unchanged and still accepts messages.

- [ ] **Step 7: Typecheck, lint, commit**

```bash
npm run typecheck && npx eslint server/modules/websocket/services/chat-websocket.service.ts
git add server/modules/websocket/
git commit -m "feat(server): /fork command branches the conversation into a new session"
```

---

### Task 7: `/subtask` prompt rewrite

`/subtask <task>` cannot be dispatched or forced via the SDK; the reliable-documented technique is explicit prompting plus `CLAUDE_CODE_FORK_SUBAGENT=1` (already always-on since Task 2). Rewrite the message content in `handleChatSend` and let the normal flow run in the SAME session. Best-effort by design — the ack text says so.

**Files:**
- Modify: `server/modules/websocket/services/chat-websocket.service.ts` (`handleChatSend`, immediately after the `/fork` block)
- Modify: `server/modules/websocket/tests/fork-command.test.ts` (already covers the parser — Task 6 Step 1)

**Interfaces:**
- Consumes: `parseSubtaskCommand` (Task 6).
- Produces: nothing new for later tasks.

- [ ] **Step 1: Implement the rewrite**

In `handleChatSend`, after the `/fork` block and before `const command = ...` (line ~192), replace the `command` assignment with:

```ts
  let command = typeof data.content === 'string' ? data.content : '';

  const subtaskCommand = provider === 'claude' ? parseSubtaskCommand(command) : null;
  if (subtaskCommand) {
    // /subtask maps to the fork subagent (inherits full conversation context).
    // There is no SDK API to force this — explicit prompting is the documented
    // technique and CLAUDE_CODE_FORK_SUBAGENT=1 is always set. Best-effort:
    // the model usually complies but may act directly instead.
    command = [
      `Use the Agent tool with subagent_type "fork" to work on the following task in the background`,
      `(a fork inherits this conversation's full context, so do not re-explain the situation to it).`,
      `Report its result back here when it finishes. Task:`,
      '',
      subtaskCommand.task,
    ].join('\n');
  }
```

(The existing `const command` declaration at line ~192 becomes this `let` + rewrite block.)

- [ ] **Step 2: Manual verification**

Restart the backend. In a Claude session, type `/subtask draft three test case names for the last file we discussed`. Verify: the run starts in the SAME session; an `Agent` tool block appears; inspect the session JSONL (`~/.claude/projects/<encoded-cwd>/<provider-session-id>.jsonl`) and confirm the tool_use input has `"subagent_type": "fork"` (acknowledging the model may occasionally choose otherwise — one retry is acceptable evidence); the result returns into the same conversation and renders via the Task 4/5 pipeline.

- [ ] **Step 3: Typecheck, lint, commit**

```bash
npm run typecheck && npx eslint server/modules/websocket/services/chat-websocket.service.ts
git add server/modules/websocket/
git commit -m "feat(server): /subtask rewrites to an explicit fork-subagent prompt"
```

---

### Task 8: Attribute permission requests to their subagent

The SDK's `canUseTool` callback receives no parent id, so attribution is derived client-side: when a `permission_request` arrives, the child `tool_use` it belongs to is already in the store (tool_use streams before approval), carrying `parentToolUseId`. A pure matcher finds the newest result-less subagent-child tool_use with the same tool name; the banner shows which subagent asked.

**Files:**
- Create: `src/components/chat/utils/permissionAttribution.ts`
- Create: `src/components/chat/utils/permissionAttribution.test.ts`
- Modify: `src/components/chat/view/subcomponents/PermissionRequestsBanner.tsx` (render the attribution line; locate the per-request title render and add a badge under it)
- Modify: the banner's call site to pass current messages (find it: `grep -rn "PermissionRequestsBanner" src/components/chat/view/` — pass `chatMessages` from `ChatInterface`)

**Interfaces:**
- Consumes: `NormalizedMessage.parentToolUseId`; `ChatMessage.isSubagentContainer` + `toolInput` (Task 4); `isSubagentToolName` (Task 1).
- Produces: `attributePermissionToSubagent(messages: ChatMessage[], toolName: string): { description: string } | null`.

- [ ] **Step 1: Write the failing test**

```ts
// src/components/chat/utils/permissionAttribution.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { attributePermissionToSubagent } from './permissionAttribution.ts';
import type { ChatMessage } from '../types/types.ts';

const container = (desc: string, children: Array<{ toolName: string; done: boolean }>): ChatMessage => ({
  type: 'assistant',
  content: '',
  timestamp: new Date(),
  isToolUse: true,
  toolName: 'Agent',
  toolId: 'p1',
  toolResult: null,
  isSubagentContainer: true,
  toolInput: JSON.stringify({ description: desc, subagent_type: 'general-purpose', prompt: 'x' }),
  subagentState: {
    childMessages: [],
    currentToolIndex: 0,
    isComplete: false,
    childTools: children.map((c, i) => ({
      toolId: `c${i}`, toolName: c.toolName, toolInput: '{}',
      toolResult: c.done ? { content: 'ok', isError: false } : null,
      timestamp: new Date(),
    })),
  },
} as ChatMessage);

test('attributes a pending Bash permission to the running subagent', () => {
  const messages = [container('Review readme', [{ toolName: 'Bash', done: false }])];
  assert.deepEqual(attributePermissionToSubagent(messages, 'Bash'), { description: 'Review readme' });
});

test('returns null when no running subagent has a pending call of that tool', () => {
  const done = [container('Review readme', [{ toolName: 'Bash', done: true }])];
  assert.equal(attributePermissionToSubagent(done, 'Bash'), null);
  assert.equal(attributePermissionToSubagent([], 'Bash'), null);
  const otherTool = [container('Review readme', [{ toolName: 'Read', done: false }])];
  assert.equal(attributePermissionToSubagent(otherTool, 'Bash'), null);
});

test('picks the most recent matching subagent when several run', () => {
  const messages = [
    container('First', [{ toolName: 'Bash', done: false }]),
    container('Second', [{ toolName: 'Bash', done: false }]),
  ];
  assert.deepEqual(attributePermissionToSubagent(messages, 'Bash'), { description: 'Second' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/components/chat/utils/permissionAttribution.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the matcher**

```ts
// src/components/chat/utils/permissionAttribution.ts
import type { ChatMessage } from '../types/types';

/**
 * Best-effort attribution of a permission request to the subagent that
 * triggered it. The SDK's canUseTool callback carries no parent id, but the
 * child tool_use always streams into the transcript BEFORE its approval is
 * requested — so the newest incomplete subagent with a result-less child of
 * the same tool name is the requester.
 */
export function attributePermissionToSubagent(
  messages: ChatMessage[],
  toolName: string,
): { description: string } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message.isSubagentContainer || !message.subagentState || message.subagentState.isComplete) {
      continue;
    }
    const hasPendingCall = message.subagentState.childTools.some(
      (child) => child.toolName === toolName && !child.toolResult,
    );
    if (!hasPendingCall) {
      continue;
    }
    let description = 'subagent';
    try {
      const input = typeof message.toolInput === 'string' ? JSON.parse(message.toolInput) : message.toolInput;
      description = input?.description || input?.subagent_type || 'subagent';
    } catch { /* keep fallback */ }
    return { description };
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/components/chat/utils/permissionAttribution.test.ts`
Expected: 3 pass.

- [ ] **Step 5: Render the attribution in the banner**

In `PermissionRequestsBanner.tsx` (accepting a new optional `chatMessages?: ChatMessage[]` prop, passed from the component that already owns both — find with `grep -rn "PermissionRequestsBanner" src/`), where each request's tool name is rendered, add:

```tsx
{(() => {
  const attribution = chatMessages
    ? attributePermissionToSubagent(chatMessages, request.toolName)
    : null;
  return attribution ? (
    <span className="ml-2 rounded border border-purple-400/40 bg-purple-400/10 px-1.5 py-0.5 text-[10px] font-medium text-purple-600 dark:text-purple-300">
      Subagent: {attribution.description}
    </span>
  ) : null;
})()}
```

Match the file's existing JSX style when integrating (this may become a small helper component if the banner maps requests in a subcomponent).

- [ ] **Step 6: Typecheck, lint, commit**

```bash
npm run typecheck && npx eslint src/components/chat/utils/permissionAttribution.ts src/components/chat/view/subcomponents/PermissionRequestsBanner.tsx
git add src/components/chat/utils/permissionAttribution.ts src/components/chat/utils/permissionAttribution.test.ts src/components/chat/view/subcomponents/PermissionRequestsBanner.tsx
git commit -m "feat(chat): attribute permission prompts to the requesting subagent"
```

---

### Task 9: Full verification pass

**Files:** none (verification only).

- [ ] **Step 1: Automated gates**

```bash
npm run typecheck
npm run lint
npx tsx --test src/components/chat/utils/subagentToolNames.test.ts src/components/chat/hooks/useChatMessages.test.ts src/components/chat/utils/permissionAttribution.test.ts
npx tsx --test --tsconfig server/tsconfig.json server/tests/claude-sdk-options.test.js server/modules/websocket/tests/fork-command.test.ts server/modules/providers/tests/claude-sessions-subagent.test.ts
npx tsx --test --tsconfig server/tsconfig.json server/modules/providers/tests/*.test.ts
```
Expected: all clean / all pass.

- [ ] **Step 2: Manual checklist (from the spec's verification plan)**

Restart the backend first (no hot reload). Browse `localhost:5173` (never 3001).

1. Dispatch a subagent ("use a subagent to review README.md") — the Agent call renders as ONE grouped purple block live (no flat tool spam, no fake user bubble with the delegation prompt), with a working "Currently: …" indicator.
2. While it runs, open the transcript drawer — child tools stream in at full fidelity, subagent text appears between tools.
3. If a child tool needs approval, the permission banner shows the `Subagent: <description>` badge; denying it produces an error visible in the subagent's context, not an orphaned top-level error.
4. After completion, reload the page — the block and drawer render identically from persisted data (this exercises the Task 3 stamping path; before this plan, reload showed nothing grouped at all).
5. `/fork say hello` — notification row in current chat; "<name> (fork)" appears in sidebar; opening it shows inherited history; original session unaffected.
6. `/subtask review the readme` — same session, Agent tool block appears; JSONL shows `"subagent_type": "fork"`.
7. Regression: a plain non-subagent conversation (text + Bash + Read) renders exactly as before.

- [ ] **Step 3: Note deviations**

Record any implementation deviations from the spec in the plan/spec commit message or `IMPLEMENTATION_NOTES.md` per repo convention.

---

## Execution notes

- Tasks 1→2→3→4→5 are strictly ordered (each consumes the previous task's interface). Tasks 6→7 depend only on Task 2. Task 8 depends on Tasks 1+4. Task 9 last.
- `server:dev` is not watch mode — restart the backend after every server-side task before manual verification.
- The dev server reads the MAIN checkout, not this worktree — copy changed files to `/home/thaint/projects/claudecodeui/...` (or run the dev server from the worktree) when manually verifying.
