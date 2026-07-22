# Design: Fix subagent rendering + add `/fork` and `/subtask` support

**Date:** 2026-07-22
**Status:** Approved for implementation planning
**Provider scope:** Claude only (via `server/claude-sdk.js` / `@anthropic-ai/claude-agent-sdk`). Cursor/Codex/OpenCode are out of scope.

## Problem

Investigating a request to add `/fork` and `/subtask` slash-command support surfaced that ccui's *existing* subagent rendering is broken today, independent of any new command. Both `/fork` and `/subtask` ultimately produce the same kind of Agent-tool call that regular subagent dispatch does, so the existing rendering pipeline must be fixed first — building new commands on top of a broken pipeline would just reproduce the same bugs.

### Root cause 1: stale tool name check

Claude Code renamed its subagent-dispatch tool from `Task` to `Agent`. Confirmed three ways:
- Raw JSONL transcript (`~/.claude/projects/.../*.jsonl`, Claude Code v2.1.217): `{"type":"tool_use","name":"Agent","input":{"subagent_type":"general-purpose",...}}`.
- Official docs (`agent-sdk/subagents`): *"Claude invokes subagents through the Agent tool. To detect when a subagent is invoked, check for `tool_use` blocks where `name` is `"Agent"`."*
- ccui's own DB confirms the session under test was a genuine `provider: 'claude'` session, not another provider that happens to use the name `"Agent"` for something else (OpenCode does, coincidentally, for its own unrelated `agent` part type — a red herring ruled out during investigation).

ccui still hard-codes the old name in three places, so subagent grouping/rendering never fires for current Claude Code versions:
- `src/components/chat/hooks/useChatMessages.ts:146` — `isSubagentContainer = msg.toolName === 'Task'`
- `src/components/chat/tools/ToolRenderer.tsx:43` — `if (toolName === 'Task') return 'agent'`
- `src/components/chat/tools/configs/toolConfigs.ts:379` — config keyed by `Task:`

Effect observed live: a dispatched subagent renders as flat "Agent / Parameters" + "Agent / Detail" (the generic `Default` fallback config), with no progress indicator, no child-tool history, and the subagent's raw output visually indistinguishable from main-session text — because none of the purpose-built `Task` config/rendering ever matches.

### Root cause 2: two divergent grouping code paths

Separately from the naming bug, there are two different mechanisms for grouping a subagent's child tool calls under their parent, and only one of them actually groups anything:
- **Live (WebSocket):** `server/claude-sdk.js` already attaches `parent_tool_use_id` → `parentToolUseId` on every child message as it streams (line ~286-290). But `useChatRealtimeHandlers.ts` does nothing with it — it just appends raw messages to the store.
- **Persisted (reload):** `claude-sessions.provider.ts` reconstructs history from the on-disk JSONL and pre-builds a `subagentTools` array attached to the parent tool_use message. `normalizedToChatMessages()` (`useChatMessages.ts`) only groups when this pre-built field is present.

Result: even once the naming bug is fixed, a running subagent would render flat while streaming and only "snap" into a grouped block after the session reloads post-completion — an inconsistent experience, and a second place where client/server logic can drift out of sync (which is exactly the class of bug that produced root cause 1).

### Root cause 3: subagent tool calls can be silently denied

Per `agent-sdk/subagents`: *"Check Agent invocations are approved: include `Agent` in `allowedTools` to auto-approve subagent invocations... Without it, Agent invocations fall through to your `canUseTool` callback or, in `dontAsk` mode, are denied."* ccui's tools-disabled-by-default security policy means the `Agent` tool call itself is likely never explicitly allow-listed, causing the dispatch (or a nested tool inside it) to be denied outright. This matches an observed orphaned error message — `"The user doesn't want to proceed with this tool use..."` — appearing disconnected from any visible approval prompt.

## Design

### 1. Fix the tool-name mismatch

Replace the three `'Task'` string checks with `'Agent'`. To avoid breaking rendering for any already-persisted session that recorded the old name (pre-rename Claude Code versions), each check accepts **both** `'Task'` and `'Agent'` rather than a hard cutover:

```ts
const SUBAGENT_TOOL_NAMES = new Set(['Agent', 'Task']);
```

Apply this constant everywhere the three files currently do a direct string comparison. `toolConfigs.ts` keeps the `Task:` config object but is looked up under both keys (or the key is renamed to `Agent` with `Task` as an alias in `getToolConfig`).

### 2. Single grouping algorithm, live and persisted alike (chosen over two alternatives)

Two other approaches were considered and rejected:
- *Fix the live path to match the persisted path* (have `claude-sdk.js`/the store build `subagentTools` live too) — keeps two parallel implementations, the exact pattern that caused root cause 1.
- *Accept flat rendering while running, only group after reload* — smaller diff, but leaves the "flat then snaps" UX gap and doesn't fix the live experience the user actually wants (watching subagent progress in real time).

**Chosen approach:** delete the server-side `subagentTools` pre-build entirely (keep the unrelated logic in `claude-session-synchronizer.provider.ts` that skips `subagents/*.jsonl` files from the top-level session list — that's a different, still-needed concern). Add one grouping pass inside `normalizedToChatMessages()` that:
1. Scans the full flat `NormalizedMessage[]` (works identically whether the array just grew via `appendRealtime` or was just loaded via `fetchFromServer` — it's the same array, same function, every render).
2. For every message carrying `parentToolUseId`, nests it into the `childTools` of the tool_use message whose `toolId` matches.
3. Builds `subagentState` (`childTools`, `currentToolIndex`, `isComplete`) purely from this scan — no reliance on any pre-built field.

This removes the second code path outright rather than reconciling two.

### 3. Suppress the synthetic "user" bubble from subagent delegation

`normalizedToChatMessages()`'s `case 'text'` currently renders any `role: 'user'` message as a user chat bubble. A subagent's internally-composed delegation prompt arrives as a `role: 'user'` message too (from the subagent's own point of view it's a user turn), and gets misrendered as if the human typed it. Fix: text messages whose `parentToolUseId` is set are never top-level user bubbles — they belong inside the parent's transcript instead (see §4).

### 4. Subagent transcript panel (replaces the one-line compact history)

Requirement (from discussion): full transcript, scrollable, same fidelity as the main session — not the current one-line-per-tool summary (`getCompactToolDisplay`, `line-clamp-6`).

**Chosen approach:** a slide-over/drawer panel, not a new route.
- Rejected: a dedicated URL/route (`/session/:id/subagent/:toolId`) — adds router/deep-link complexity and loses main-session scroll position on navigate-back, with no benefit over a drawer for this use case.
- Rejected: keep the inline one-liner list — doesn't meet the stated requirement.

Implementation:
- `SubagentContainer.tsx`'s existing toggle opens a drawer instead of expanding inline (the live "Currently: ..." indicator stays as-is on the collapsed block, unchanged).
- New small component (e.g. `SubagentTranscriptPanel.tsx`) takes the subagent's `childTools` (now correctly populated per §2) plus the delegation prompt/description, converts them into `ChatMessage[]`, and renders them through the **existing** `ToolRenderer`/`toolConfigs` pipeline — the same one used for the main session. No new rendering logic; the panel is a scrollable container plus a loop over the existing renderer.
- Requires **`CLAUDE_CODE_FORWARD_SUBAGENT_TEXT=1`** (see §6) — without it, Claude Code only emits the subagent's `tool_use`/`tool_result` blocks, never its own text/thinking. Without this env var the panel would show tool calls but never the subagent's reasoning between them.

### 5. Permission/approval routing for nested calls

- Add `Agent` to the `allowedTools` passed to `query()` in `claude-sdk.js` so subagent *dispatch* is never itself denied by falling through to `canUseTool` — this is the sanctioned SDK pattern, not a broadening of the tools-disabled-by-default policy: it only auto-approves the act of *starting* a subagent, not what the subagent does inside it. Tools the subagent itself calls (Bash, Read, Edit, ...) still go through the existing approval flow and existing tools-disabled-by-default default.
- Any `permission_request` event whose underlying tool call carries `parentToolUseId` must be attributed to that parent in the UI (e.g. rendered inside/near the subagent block, not as a bare top-level banner) so a denial's resulting error is traceable instead of orphaned. Exact UI treatment (banner vs. inline prompt inside the drawer) is left to implementation, but the requirement is: the approval prompt and any resulting error must visibly belong to the subagent that triggered them.

### 6. `/fork` — explicit backend interception, not text passthrough

Verified directly against a running SDK session: `/fork` and `/subtask` do **not** appear in the `system/init` message's `slash_commands` list (the only commands actually dispatchable through headless `query()`). Forwarding the literal text `/fork ...` as a prompt would just be interpreted by the model as ordinary text — it would not perform a real fork. (Confirmed against official docs: *"Only commands that work without an interactive terminal are dispatchable through the SDK."*)

Design: ccui's backend recognizes a `/fork <prompt?>` prefix typed in the composer and translates it into an explicit SDK call, rather than forwarding the text:
```js
queryClaudeSDK({
  resume: currentSessionId,
  forkSession: true,
  prompt: promptTextAfterFork || undefined, // optional
})
```
- The resulting session gets its own `session_id`/`provider_session_id`, inserted into ccui's `sessions` table like any other session — no special-casing needed for it to show up, since `sessions-watcher.service.ts` and the sidebar already handle any new session row generically (confirmed earlier: it watches the same project directory and doesn't distinguish how a session came to exist).
- **Decision (from discussion): stay on the current session; the new forked session only appears in the sidebar.** The user does not get auto-navigated into it.
- Title convention: derive from the original session's title + `" (fork)"` suffix (matching the CLI's own convention), so the two are distinguishable in the sidebar without extra UI work.

### 7. `/subtask` — explicit prompting + required env, not deterministic

Also confirmed absent from `slash_commands`. Unlike `/fork`, there is **no host-side API to force this behavior** — a forked subagent can only come into existence because Claude itself chooses to call the Agent tool with `subagent_type: "fork"`. There is no equivalent of `forkSession: true` for this case.

What *is* confirmed reliable (via a GitHub issue on the docs repo, anthropics/claude-code#54163, and the changelog entry it cites): `CLAUDE_CODE_FORK_SUBAGENT=1` now works in non-interactive/SDK sessions (this was previously interactive-only; the docs were out of date, not the behavior). Combined with the SDK's own documented technique for reliably invoking a specific subagent type — *"Use explicit prompting: mention the subagent by name in your prompt"* — the design is:

- ccui backend recognizes `/subtask <task>` typed in the composer and rewrites the sent prompt to something like: `Use the fork subagent type (via the Agent tool) to work on: <task>`.
- Sets `CLAUDE_CODE_FORK_SUBAGENT=1` on the spawned process env (`sdkOptions.env`, alongside the existing full `process.env` forward in `claude-sdk.js`).
- This is explicitly a **best-effort** mechanism, not a guarantee — document this limitation directly in the UI or command help text so it isn't a silent surprise (e.g. "Claude will usually honor this, but may choose to work on it directly instead").
- Rendering: no new UI — a `/subtask` invocation produces an `Agent` tool_use exactly like any other subagent dispatch, so it renders through the same fixed pipeline (§1-§4) and gets the same transcript panel automatically. The only visual difference worth considering (not required) is a label distinguishing "inherited context" (fork) from "fresh context" (named/general-purpose) subagents in the block title.

### 8. Required env/config additions (`server/claude-sdk.js`)

Three env vars need to be set on the spawned subprocess (via `sdkOptions.env`, which already forwards the full host `process.env` — these are additive, not overlaying):
| Var | Purpose | Scope |
|---|---|---|
| `CLAUDE_CODE_FORK_SUBAGENT=1` | Lets Claude request `subagent_type: "fork"` via the Agent tool | Set always, or at minimum whenever a `/subtask` is in flight |
| `CLAUDE_CODE_FORWARD_SUBAGENT_TEXT=1` | Emits subagent text/thinking blocks (not just tool_use/tool_result) — required for §4's transcript panel to show anything beyond raw tool calls | Set always, since the transcript panel applies to *any* subagent, not just `/subtask` |
| `allowedTools` includes `Agent` | Prevents subagent dispatch itself from being silently denied (§5) | Always |

## Non-goals / explicit limitations

- **No mid-flight steering.** The CLI's interactive "observe and steer running forks" panel (open a fork's transcript, send it follow-up messages while it runs) is not replicable — the Agent SDK's `query()` model is single-request/response; there is no API to inject a message into a nested Agent-tool call that's already in flight. The transcript panel (§4) is read-only, live-updating, not interactive.
- **`/subtask` is not deterministic.** Documented above; this is a real constraint of the underlying SDK, not a gap in this design.
- **Other providers unaffected.** Cursor/Codex/OpenCode are untouched; this entire spec is Claude-provider-specific.
- **No new route/page.** Both the transcript panel and `/fork`'s new session use existing surfaces (a drawer, and the existing sidebar/session-list mechanism), not new navigable screens.

## Verification plan

- Reuse the already-identified real session (`0291feec-ee22-4983-aabd-b7ffbd2959e0`, a genuinely rejected/denied Agent-tool call) to confirm the `Agent` allowlist fix (§5) resolves that specific denial, then re-run a similar prompt end-to-end to confirm grouping (§1-§2) and the transcript panel (§4) render correctly both live and after reload.
- Manually test `/fork` from an existing session: confirm the new session appears in the sidebar without navigating away, and that resuming the original session is unaffected.
- Manually test `/subtask`: confirm the rewritten prompt is sent, and inspect the resulting JSONL tool_use block for `subagent_type: "fork"` to confirm Claude actually honored it (acknowledging it may not always).
