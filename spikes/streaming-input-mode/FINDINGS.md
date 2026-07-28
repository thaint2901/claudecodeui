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
| `canUseTool` across turns | fired **once** (turn 1), **not** on turn 2 | ⚠️ semantics change — see H1 |
| `backgroundTasks()` — the Ctrl-B equivalent | `true` | ✅ new capability unlocked |
| `stopTask(id)` | works, emits `task_notification` `status=stopped` | ✅ |
| `setPermissionMode()` | ok | ✅ |
| `interrupt()` | ok, session usable afterwards — but **no `result` emitted** | ⚠️ see H2 |
| Fork mid-stream | no control method exists | ⚠️ see H3 |

### Q-B — RAM cost of a live session

`~302 MB` RSS at turn-1 end, `~321 MB` after 3 turns (idle). Call it **~320 MB per live session**.

a30 context (measured): 128 GB total, **75.6 GB available**, load avg 13.46, 185 logged-in users,
**290 non-archived session rows** in `auth.db`.

## Hazards to design around (none is a blocker)

**H1 — approval becomes per-session instead of per-turn.** `canUseTool` fired only on the first
Bash call; the second turn's Bash was not re-checked. Today every ccui turn is a fresh process, so
approvals never persist. In streaming mode they do — which matches interactive Claude Code, but it
is a **behaviour change to a security-relevant default** (ccui ships Claude tools disabled by
default). Must be an explicit, deliberate decision in the spec, not a side effect.

**H2 — `interrupt()` produces no turn terminator.** The interrupted turn emitted no `result`
within 30s; the session remained fully usable and the next turn succeeded. ccui's run loop and
`chatRunRegistry` currently key terminal state off the generator/`result`, so an abort would leave
the run hanging. ccui already synthesises its own aborted-complete message via `abortedSessionIds`
(`claude-sdk.js:897`), so this is tractable — but it must be wired deliberately.

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

Required guardrail: an **LRU cap on live processes plus idle eviction**, because 290 session rows
× 320 MB is not a budget that exists. Suggested starting point: cap ~8–10 live sessions, evict
after 10–15 min idle → ~3.2 GB, about 4% of a30's available RAM. Sessions beyond the cap fall back
to today's per-turn `resume` path, which still works — it just cannot hold background shells.

Not covered by this spike, and worth resolving in the spec:

- Turn demux inside one long-lived `for await` loop (`chatRunRegistry.startRun` / `lastSeq` /
  `replayEvents` assume one run per loop).
- Recovery when the persistent process dies mid-session — fall back to a fresh `query({resume})`.
- Whether image prompts, MCP servers, and `settingSources` behave identically across turns.
