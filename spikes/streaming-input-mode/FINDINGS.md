# Spike: streaming input mode — findings

**Date:** 2026-07-28 · **SDK:** `@anthropic-ai/claude-agent-sdk` 0.3.165 · **CLI:** 2.1.220
**Status:** spike only. Nothing here is production code and nothing in `server/` was touched.

## Why this spike exists

ccui kills background shells. Root cause: ccui runs the SDK in **single-message mode** —
`buildPromptPayload()` (`server/claude-sdk.js:495`) returns a plain string (or a generator that
yields once and closes), so the CLI sees end-of-input, finishes the turn, and the subprocess exits.
The backgrounded shell is a child of that subprocess and dies with it. Docs confirm this is
deliberate for headless runs: *"Background Bash tasks initiated during a `claude -p` run are
terminated approximately five seconds after Claude returns its final result."*

Two cheaper escapes were tested and **ruled out** before this spike:

| Escape | Result |
|---|---|
| `CLAUDE_BG_BACKEND=daemon` + `CLAUDE_JOB_DIR` (bg-exit-handoff) | A/B tested — identical to control, task still died |
| Rely on `resume` to rehydrate the task next turn | Docs: *"background Bash and monitor tasks are **not**"* restored |

So streaming input mode is the only path to parity. This spike checks whether it is actually
compatible with ccui, rather than assuming it.

## How to reproduce

```bash
node spikes/streaming-input-mode/harness.mjs
```

The harness mirrors ccui's real option set — host `env` forwarding, a `Notification` +
`PreToolUse` hook pair, `canUseTool`, `permissionMode`, `pathToClaudeCodeExecutable` — so results
are evidence about ccui, not about a toy. It keeps one `query()` open and pushes 3 user turns
through a persistent `AsyncIterable`.

## Results

### Q-0 (premise) — does a background shell survive a turn boundary? **YES**

The claim the whole plan rests on, so it was measured rather than assumed:

```
turn-1 end   -> ticks=2
+12s idle    -> ticks=8    *** SURVIVED ***
turn-2 end   -> ticks=11
final        -> ticks=33
```

One process served **3 turns** under a **single session id** — no id churn.

### Q-A — compatibility with ccui's integration points

| Probe | Result | Verdict |
|---|---|---|
| Hooks (`PreToolUse`) across turns | fired on turn 1 and turn 2 | ✅ works |
| `canUseTool` across turns | ~~fired once (turn 1), not on turn 2~~ **RETRACTED — fires every turn** | ✅ see H1 |
| `backgroundTasks()` — the Ctrl-B equivalent | `true` | ✅ new capability unlocked |
| `stopTask(id)` | works, emits `task_notification` `status=stopped` | ✅ |
| `setPermissionMode()` | ok | ✅ |
| `interrupt()` | ok, session usable afterwards; ~~no `result` emitted~~ **RETRACTED — a `result` IS emitted** | ⚠️ see H2 |
| Fork mid-stream | no control method exists | ⚠️ see H3 |

### Q-B — RAM cost of a live session

`~302 MB` RSS at turn-1 end, `~321 MB` after 3 turns (idle). Call it **~320 MB per live session**.

a30 context (measured): 128 GB total, **75.6 GB available**, load avg 13.46, 185 logged-in users,
**290 non-archived session rows** in `auth.db`.

## Hazards to design around (none is a blocker)

**H1 — RETRACTED. Approval stays per-turn; there is no hazard here.**

The original H1 claimed approval becomes per-session, because `canUseTool` fired on turn 1's Bash
and not on turn 2's. That comparison was invalid: turn 1 ran a gated
`bash -c 'for i in $(seq 1 90); …'` while turn 2 ran `echo turn2-alive`, which the CLI classifies as
safe and never routes through `canUseTool` at all. Two different commands, so the difference said
nothing about caching.

Re-measured with the SAME command shape in both turns, and with a guard that refuses to answer
unless turn 1 was actually gated (`approval-per-turn.mjs`):

```
TURN 1 canUseTool consulted: 1
TURN 2 canUseTool consulted: 1
>>> YES: approval is per TURN — the second turn was re-consulted.
```

So a held process does **not** inherit turn 1's approvals, and nothing a user can do escapes a
prompt that would have prompted on `main`. The design spec's "Approval semantics" risk paragraph is
retracted with this.

**H2 — RETRACTED, and the correction inverts the design consequence.**

The original H2 claimed an interrupted turn emits no terminator, which is why `claude-sdk.js` settles
the turn itself on abort. Re-measured with a guard proving a turn was genuinely mid-flight (a
`tool_use` seen, no `result` yet) before interrupting — `interrupt-result.mjs`:

```
[4.3s] tool_use Bash
[8.0s] calling interrupt()…
[8.0s] interrupt() resolved -> undefined
[8.0s] RESULT subtype=error_during_execution
```

A `result` arrives in **milliseconds**, not never. The likely cause of the original reading is
interrupting when no turn was in flight — there is then nothing to terminate, so nothing is emitted.

This inverts the design consequence. Settling the turn ourselves on abort **vacates the turn slot
while the CLI is still emitting**, and `SDKResultMessage` carries no turn-correlation field (only
`uuid` / `session_id` / `num_turns`), so a frame arriving after the slot is reused cannot be
attributed to the turn it belongs to. The pool should keep the slot until the real terminator lands,
with a timed fallback for the one case that genuinely produces no terminator: `interrupt()` failing.

Note `interrupt()` is `Promise<void>` on SDK 0.3.165 — the `interrupt_receipt_v1` capability and
`SDKControlInterruptResponse` described in the current docs are not in this version.

Related, and now documented rather than suspected: single-message mode **does not support
real-time interruption** at all. So ccui's current Stop button deserves its own test regardless of
this spike's outcome.

**H3 — fork means a second process, not a mid-stream switch.** The control surface is
`interrupt / setPermissionMode / setModel / setMaxThinkingTokens / setMcpServers / streamInput /
stopTask / backgroundTasks / close`. There is no fork control, and `forkSession` / `resumeSessionAt`
are `query()` options. So forking spawns a new persistent process. ccui's fork flow already creates
a new app session, so this fits — but forks count against the memory budget.

## Recommendation

Streaming input mode is **viable**. Parity on background shells is real (Q-0), and it additionally
unlocks Ctrl-B backgrounding, task stopping, and mid-session model/permission changes — all of
which are unreachable today.

~~Required guardrail: an LRU cap on live processes plus idle eviction … cap ~8–10 live sessions,
evict after 10–15 min idle.~~ **RETRACTED — no cap shipped, deliberately.**

This recommendation rested on a premise the design then dropped: that RAM scales with *session rows*.
It does not. The shipped pool is keep-alive-**on-demand** — a session with no background work closes
its process at turn end exactly as before — so cost scales with sessions that actually have
background work, and the 290 non-archived rows stop being the relevant number.

An LRU cap or a maximum hold time would also evict by killing the user's running work, which is
precisely the bug this design exists to fix. The repo owner's ruling is therefore **warn, never
evict**, recorded under "Accepted risks" in the design spec. Read that section, not this paragraph,
for the current policy.

Not covered by this spike, and worth resolving in the spec:

- Turn demux inside one long-lived `for await` loop (`chatRunRegistry.startRun` / `lastSeq` /
  `replayEvents` assume one run per loop).
- Recovery when the persistent process dies mid-session — fall back to a fresh `query({resume})`.
- Whether image prompts, MCP servers, and `settingSources` behave identically across turns.

---

## Follow-up probe: `live-deny.mjs` — can a tightening reach a RUNNING CLI?

Added during the final-review fix round, because the pool's option-reconciliation path had a claimed
residual gap: a tool removed from `allowedTools` mid-session was said to stay auto-approved inside
the CLI until the process closed. Run with `node spikes/streaming-input-mode/live-deny.mjs`.

Setup mirrors production: `permissionMode: 'default'`, `allowedTools: ['Bash','Agent','Task']`
(the shape `mapCliOptionsToSDK` builds, dispatch tools auto-injected), one background shell started
first so the session is protected from recreation exactly as the pool protects it.

Observed against CLI 2.1.220 / SDK 0.3.165:

```
STEP 1 canUseTool consulted           : 0 []
STEP 1 tool_result                    : [{"isError":false,"text":"BASELINE-OK"}]
STEP 1 VERDICT (the hole)             : STILL AUTO-APPROVED — live tightening does NOT enforce
STEP 4 canUseTool consulted           : 1 ["Bash"]
STEP 4 VERDICT (live 'ask')           : PROMPTED (reached canUseTool)
STEP 6 canUseTool consulted           : 0 []
STEP 6 tool_result                    : [{"isError":true,"text":"Permission to use Bash has been denied."}]
STEP 6 VERDICT (live 'deny')          : DENIED by the CLI
background task still alive afterwards : true
```

**Findings.** The gap is real (STEP 1: a tool in the spawn allowlist is auto-approved with
`canUseTool` never consulted, so no amount of refreshing our own state can tighten it). And it is
closable without recreating the process: `applyFlagSettings({ permissions: … })` is a streaming-only
control request that reaches the CLI's own permission engine — `ask` routes the call back through
`canUseTool` (restoring the prompt a freshly spawned process would have produced), `deny` refuses it
outright. Neither disturbed the protected background task.

**Caveat found while measuring:** successive `applyFlagSettings` calls *replace* the whole
`permissions` object rather than merging — STEP 5's `{deny:[...]}` dropped STEP 3's `{ask:[...]}`.
The pool therefore always sends a complete layer and clears with `permissions: null`.

---

## Correction probes, and why this directory now has a shared lib

Two of this spike's three hazards (H1, H2) were wrong, for the same methodological reason: the probe
had no way to distinguish "the hypothesis is false" from "the thing I meant to measure never
happened". `live-deny.mjs` was the first script here to add that guard; the three probes below are
built on `_probe-lib.mjs`, which makes it mandatory.

| Probe | Question | Verdict |
|---|---|---|
| `approval-per-turn.mjs` | Is a tool approval per turn or per session on a held process? | per **turn** — H1 retracted |
| `interrupt-result.mjs` | Does an interrupted turn emit a terminator? | yes, `error_during_execution` in ms — H2 retracted |
| `task-classification.mjs` | Which tracked tasks can outlive their turn? | see below |

`_probe-lib.mjs` encodes three rules, each of which exists because breaking it produced a wrong
finding that reached a spec: **(1)** neutralise env at BOTH layers (`options.env` *and*
`settingSources`), because `options.env` cannot remove what `settings.json` sets; **(2)** compare the
same object/command shape in both arms; **(3)** always provide an `inconclusive` branch, printed
first so it cannot be read as a result.

### Task classification (`task-classification.mjs`)

```
task_started by task_type : {"local_bash":1,"local_agent":1}
is_backgrounded reported  : (none)
```

A backgrounded Bash reports `task_type: 'local_bash'`; a subagent reports `'local_agent'` and, in
this run, settled inside its own turn via `task_updated {status: 'completed'}`.

Two consequences for the pool's `liveTaskIds`, both against narrowing the filter:

- **`is_backgrounded` cannot be relied on** — the field exists in `SDKTaskUpdatedMessage.patch` but
  was never emitted in this run.
- **Filtering to `local_bash` only would under-hold.** Whether a subagent outlives its turn depends
  on env: with `CLAUDE_CODE_FORK_SUBAGENT` set (true on the dev box via `~/.claude/settings.json`,
  false on a30) subagents are backgrounded and DO outlive the turn, so holding the process for them
  is correct. Dropping `local_agent` from the tracked set would kill them on exactly the hosts where
  the flag is on.

And there is no ground-truth query to reconcile against: `backgroundTasks(toolUseId?)` returns
`Promise<boolean>` — it is the Ctrl-B *action*, not a listing of running tasks. So tracking every
`task_started` (failing toward holding) stays the right default, and the real gap to close is that a
task whose terminal frame never arrives holds the process **unobservably** — the fix is a long-hold
warning, not a narrower filter and not eviction.
