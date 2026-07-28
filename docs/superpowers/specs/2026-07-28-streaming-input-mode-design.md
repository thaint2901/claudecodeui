# Design: keep background shells alive across turn boundaries

**Date:** 2026-07-28
**Status:** design, approved for planning
**Scope decision:** narrow — background shells survive and report truthfully. No new buttons.
**Spike:** PR #9 (`spikes/streaming-input-mode/`)

## Problem

ccui promises something it cannot deliver. When a Bash command exceeds its 120s timeout, Claude
Code backgrounds it and tells the model *"You will be notified when it completes."* In ccui that
notification never comes with real results, because the command is already dead.

Reproduced end-to-end on the dev instance: a shell asked to emit 100 ticks emitted **3**, then
froze the instant the turn ended. The next message surfaced `<status>stopped</status>` —
*"no completion record was found for this background shell command from the previous session."*

The same sequence is in the a30 session `23c431f6-d95b-4467-ba67-905abd0c5785`, where an
auto-backgrounded sonar scan left a **0-byte** output file. That is the user-facing pain this
design fixes.

### Why it happens — proven, not inferred

ccui runs the Agent SDK in **single-message mode**. `buildPromptPayload()`
(`server/claude-sdk.js:495`) returns a plain string, or — when images are attached — a generator
that yields once and closes. Either way the CLI sees end-of-input, finishes the turn, and the
subprocess spawned at `server/claude-sdk.js:724` exits. The backgrounded shell is its child.

The Agent SDK is not an API client: it spawns the real `claude` binary
(`pathToClaudeCodeExecutable`, `server/claude-sdk.js:192`). Confirmed live — during a turn a
`claude --output-format stream-json --input-format stream-json …` process appears as a child of
the ccui server process, and disappears when the turn ends.

The reaper's gate was read directly out of CLI 2.1.220:

```js
function Pxm({runningBackgroundTasks:e, inputClosed:t, hasMainThreadQueued:r, ...}){
  if(!(t && !r && !n && e.length>0 && (i || !o && !e.some(zEe))))
    return {deadline:null, swept:false, shouldSweep:false};
```

The sweep-and-kill branch runs **only when `inputClosed === true`**. So keeping the input stream
open is not a workaround that happens to help — it is exactly the condition that disarms the
killer. Docs corroborate: *"Background Bash tasks initiated during a `claude -p` run are
terminated approximately five seconds after Claude returns its final result."*

### Alternatives considered and rejected

| Alternative | Why rejected |
|---|---|
| bg-exit-handoff via `CLAUDE_BG_BACKEND=daemon` + `CLAUDE_JOB_DIR` | A/B tested at SDK level. Treatment arm identical to control — task still died at 5 ticks. The documented handoff covers an interactive session being *stopped/restarted*, not a headless run that *completed*. |
| Let `resume` rehydrate the task on the next turn | Docs, sessions page: *"Scheduled tasks that have not expired are restored, but **background Bash and monitor tasks are not**."* |
| `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0` (wait instead of kill) | The process would block on the task, so the generator never closes, `spawnFn` never resolves, and the run stays "processing" forever. Trades a silent loss for a visible hang. |
| Raise `BASH_DEFAULT_TIMEOUT_MS` only | Legitimate mitigation, not a fix — it shrinks the window rather than closing it. Recommended as an independent quick win, tracked separately. |

## Goals

1. A background shell started in turn *N* keeps running after turn *N* ends.
2. When it settles, its real status and output path reach the UI — including when **no turn is in
   flight**.
3. When the OS memory-pressure reaper kills a task, the user is told. Losses become visible, never
   silent.
4. No change to the `spawnFn` contract, so the WebSocket layer and run registry keep working.
5. No RAM regression for sessions that never use background work.

## Non-goals

Explicitly out of scope, to be specced separately if wanted:

- A Ctrl-B style "push to background now" button (`backgroundTasks()` — verified working).
- A panel listing running background tasks with a stop button (`stopTask()` — verified working).
- Providers other than Claude (Cursor, Codex, OpenCode).
- Mid-session `setModel`, and parity verification for image prompts / MCP servers /
  `settingSources` across turns.

## Architecture: keep the process alive only while there is background work to protect

Three candidate lifetimes were weighed:

- **Per open session** — one live process per open session. Maximum parity, but ~320 MB RSS each
  (measured), against 290 non-archived session rows on a30. Requires an LRU cap plus eviction, and
  buys parity features that this scope explicitly excludes.
- **On demand (chosen)** — close the process at turn end exactly as today *unless* background work
  is still running. If it is, hold the input stream open so the task lives; reuse that live process
  for the session's next turn; close once the tasks settle and an idle grace period passes.
- **Env-var only** — rejected above.

On demand wins because it is the smallest architecture that satisfies the chosen scope. RAM is
spent only by sessions that actually have background work, so the 290-row figure stops mattering
and no LRU cap is needed for normal operation. It also uses the proven `inputClosed` switch
directly: close the input only when there is nothing left to lose.

### Components

**`server/claude-session-pool.js`** (new, top-level alongside `claude-sdk.js`)

Owns process lifetime. Placed top-level rather than under `server/modules/` because it is
intimately coupled to `claude-sdk.js`, which is itself top-level legacy; putting it inside a module
would create exactly the cross-module deep import that `eslint-plugin-boundaries` rejects.

Responsibilities, and nothing else:

- `runTurn({ appSessionId, message, writer, sdkOptions })` → pushes a `SDKUserMessage` into the
  session's open input stream, creating the live session (and its `query()`) if absent. Returns a
  promise that resolves when **this turn's** `result` arrives.
- One drain loop per live session, consuming the query generator and routing events to the current
  turn's writer, or to the session sink when no turn is in flight.
- Close policy: at turn end, close unless the session has live background tasks. Close after tasks
  settle plus an idle grace period (default 60s). **Never close a session with live background
  tasks** — that would re-create the bug through the memory-saving path.

Tracking live tasks is the pool's own bookkeeping and must be explicit. Do **not** parse
tool_result prose for it — the SDK emits typed messages for exactly this, and string matching
would fail toward the dangerous direction (a missed announcement leaves the set empty, so the pool
closes the process and kills the task).

The pool keeps a `Set<task_id>` per live session, driven by typed `SDKMessage` variants:

| Event | Type | Effect on the set |
|---|---|---|
| `SDKTaskStartedMessage` | `type:'system'`, `subtype:'task_started'`, `task_id` | add |
| `SDKTaskNotificationMessage` | `subtype:'task_notification'`, `task_id`, `status: 'completed' \| 'failed' \| 'stopped'`, `output_file`, `summary` | remove |
| `SDKTaskUpdatedMessage` | `subtype:'task_updated'`, `task_id`, `patch.status` | remove on `completed \| failed \| killed`; `killed` is the memory-pressure reaper's signal |

An empty set is the only signal that closing is safe. Track every `task_id`, including subagent and
workflow tasks — they are equally killable. `skip_transcript: true` marks ambient housekeeping
tasks: exclude those from UI display, but still track them for lifetime, since closing the process
would kill them too.
- Fallback: if a live process cannot be created or has died, fall back to today's one-shot
  `query({ resume })` path. Degraded but functional — it simply cannot hold background shells.

**`server/claude-sdk.js`** (modified)

`buildPromptPayload()` stops being the input. It becomes a helper that builds one `SDKUserMessage`,
which the pool pushes. `queryClaudeSDK()` delegates to `claudeSessionPool.runTurn()` and keeps its
existing signature, so `chat-websocket.service.ts:503` is untouched.

`abortClaudeSDKSession()` gains one requirement: after `interrupt()`, settle the in-flight turn
promise itself. The spike showed an interrupted turn emits **no `result`** while the session stays
usable — so without this, `spawnFn` never resolves. `interrupt()` must not close the process.

**Session event sink** (small addition to the websocket module)

The mechanism that makes goal 2 possible. Today `writer` is per-run, so an event arriving between
turns has nowhere to go. The sink forwards session-scoped events to whichever clients are watching
that session, following the precedent already in
`chat-run-registry.service.ts:115`, which iterates `connectedClients` from
`websocket-state.service.ts:16` for `broadcastCanonicalSessionUpsert`.

New outbound frame `kind: 'background_task'` carrying `{ sessionId, taskId, status, outputFile,
summary }`.

**Frontend (`src/components/chat/hooks/useChatRealtimeHandlers.ts`)**

The new kind **must** get its own explicit `case`. This is a known landmine recorded in
`CLAUDE.md`: an unhandled kind falls through to `default`, which force-casts the frame into
`NormalizedMessage` and calls `sessionStore.appendRealtime()`. A frame with no `.id` corrupts that
session's message store and crashes every later merge on `.id.startsWith`. The kinds at lines
190–196 (`session_upserted`, `loading_progress`, `session_lock_state_changed`) are the precedent to
follow — handled, not appended.

### Data flow

Turn with background work:

1. `chat.send` → `chatRunRegistry.startRun()` → `spawnFn(command, options, writer)` (unchanged).
2. Pool finds no live session, creates the input stream and `query()`, pushes the turn.
3. Drain loop streams events to `run.writer`. Bash exceeds its timeout; CLI backgrounds it and
   returns *"running in background with ID …"*.
4. `result` arrives → pool resolves the turn promise → `spawnFn` returns →
   `completeRunIfCurrent` (`chat-websocket.service.ts:513`) closes the run. The UI stops showing
   "processing".
5. Pool sees live background tasks, so it **does not** close the input. The `claude` process and
   the shell keep running.
6. Task settles → `task_notification` arrives on the generator with no turn in flight → session
   sink → `kind: 'background_task'` → the UI shows the real status.
7. No tasks left; after the idle grace period the pool closes the input and the process exits.

Turn without background work: steps 1–4, then the pool closes immediately. Identical to today's
behaviour and RAM profile.

### Policy decisions

**Memory-pressure reaper stays enabled.** `CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP` exists, but
a30 is a shared box — 128 GB total, 75.6 GB available, load average ~13, 185 logged-in users.
Disabling the OS-pressure safety valve there would be antisocial. Instead, reap events are
surfaced through the same `background_task` frame, so a loss is always visible. This is a stated
assumption, cheap to reverse by setting the variable.

**`CLAUDE_CODE_BG_TASKS_REPORT_RUNNING`** governs whether a session reports itself as running while
background tasks are alive. Implementation must confirm that ccui's session status stays correct
after a turn ends with a task still running — the UI must not show "processing" for a completed
turn, nor claim idle in a way that hides live work.

### Error handling

| Failure | Behaviour |
|---|---|
| Live process dies mid-session | Drain loop sees the generator end or throw. Mark the session dead; reject any in-flight turn promise so `spawnFn` settles and the existing safety net at `chat-websocket.service.ts:513` fires. Next turn falls back to one-shot `query({ resume })`. |
| Interrupt / abort | Settle the in-flight turn ourselves; keep the process. Existing `abortedSessionIds` handling still emits the aborted terminal event. |
| Task reaped under memory pressure | Surface via `background_task`; do not retry automatically. |
| Pool cannot create a live session | Fall back to the one-shot path and log. Background shells are lost as they are today — no worse than the status quo. |
| Server restart | Live processes die with the server. On the next turn the session resumes from disk, as today. Any background task is gone; the next `task_notification` will report `stopped`, which is honest. |

### Testing

- **Regression test from the spike.** `spikes/streaming-input-mode/harness.mjs` already measures
  tick survival across a turn boundary. Promote its core assertion — ticks must keep climbing after
  `result` — into a runnable test.
- **Pool unit tests**, following `server/modules/websocket/tests/chat-run-registry.test.ts`. Cover
  turn demux (two sequential turns on one process, events routed to the right writer), close-on-
  turn-end when no tasks, no-close when tasks are live, idle close after tasks settle, fallback
  when process creation fails, and turn-promise settlement on interrupt.
- **Frontend guard.** Assert `background_task` hits its own `case` and never reaches
  `appendRealtime()`.
- Run server tests with `npx tsx --test --tsconfig server/tsconfig.json <path>` — `vitest` cannot
  resolve the `@/` alias in this checkout.

### Risks

- **Turn demux is the highest-risk change.** Everything downstream assumes one run per loop. A
  mis-routed event lands in the wrong session's store. Mitigated by unit tests that assert routing
  across two sequential turns, and by leaving the `spawnFn` contract untouched.
- **Fork.** No control method exists to fork mid-stream; `forkSession` / `resumeSessionAt` are
  `query()` options, so a fork spawns its own live session. The existing fork flow already creates a
  new app session, so this fits — but `recaptureForkSession` (`server/claude-sdk.js`) must be
  re-checked against the pool, since it remaps the provider id mid-stream.
- **Approval semantics.** Under `permissionMode: 'default'` the spike saw `canUseTool` fire once
  per session rather than once per turn. This does not affect current usage — the a30 session ran
  `bypassPermissions` for all 1373 recorded hook payloads, and `bypassPermissions` skips
  `canUseTool` entirely. But the persistent process fixes `permissionMode` at creation, so toggling
  it mid-session must call `setPermissionMode()` (verified working) rather than relying on the next
  turn spawning a fresh process.

## Success criteria

1. A background shell started in one turn is still running and still producing output after the
   next turn completes — verified by the promoted spike assertion.
2. The completing task's real status reaches the UI with no turn in flight.
3. A session that never starts background work spawns and exits exactly one process per turn, as
   today.
4. Abort settles the run rather than hanging it.
5. `npm run typecheck` and `npm run lint` clean; new pool tests pass.

---

## Amendments after implementation (2026-07-28)

Three claims in this spec turned out to be wrong once the code met reality. Recorded here so the
document does not misdescribe what shipped.

**1. The WebSocket layer was NOT untouched.** This spec claimed the `spawnFn` contract would not
change and the websocket layer would keep working as-is. In fact `options.sessionId` carries the
**provider-native** session id, not the app session id. The pool must be keyed on the app id —
forks change the provider id mid-stream via `recaptureForkSession`, and a brand-new session has no
provider id until its first message. So a new `appSessionId` was threaded through
`server/modules/websocket/services/chat-websocket.service.ts` (+11 lines) at both `spawnFn` call
sites: the ordinary chat send and the fork send. Implemented in commit `5e1491b`.

**2. The close/recreate race is the hot path, not an edge case.** Task 2's review found that an
unguarded delete from the pool's live map let a superseded session's teardown remove the current
session's entry, but could not tell whether the sequence was reachable. It is, and constantly:
every turn that ends with no live background task closes the process synchronously before
`runTurn`'s promise resolves, while the subprocess teardown is still asynchronous — so the next
`chat.send` for the same session can start a new turn before the old drain loop's `finally` runs.
The identity-guarded removal is load-bearing.

**3. Abort must not decide whether to close.** This spec's error-handling table said abort should
settle the in-flight turn and keep the process. That was right but insufficient: the first
implementation also closed the session when no task appeared live. No check made from OUTSIDE the
pool can be sound, because a `task_started` still undelivered in the SDK's async iterator is
invisible to `getLiveTaskIds` at the moment of asking — an external check-then-close is racy by
construction, not merely by timing. Abort now only settles the turn; the pool's idle timer owns the
close decision and re-reads live-task state when it fires, inside the drain loop. Cost: an idle
aborted session lingers up to 60 s instead of closing at once. Implemented in commit `e15f9a1`.

**Test-runner note.** `server/claude-sdk-abort-race.test.ts` uses `mock.module`, so any aggregate
test command must include `--experimental-test-module-mocks`. Without it the file fails loudly
(exit 1) rather than being skipped, so a suite that checks its exit code cannot be fooled.
