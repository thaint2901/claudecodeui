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
5. No RAM regression for a session that completes its turns normally and never
   uses background work: it spawns and exits exactly one process per turn, as today.
   **One bounded exception, added post-implementation:** an *aborted* turn leaves its
   process alive for up to the idle grace period (60 s) even with no background work,
   because no close decision made from outside the pool's drain loop can be sound —
   see amendment 3. So the honest statement of this goal is "no *unbounded* RAM
   regression, and none at all for turns that complete": the worst case for a
   background-work-free session is one ~320 MB process held for 60 s after an abort,
   released automatically, never accumulating.

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
- **Approval semantics — RETRACTED, no risk here.** This entry claimed that under
  `permissionMode: 'default'` the spike saw `canUseTool` fire once per session rather than once per
  turn, and dismissed it on the grounds that a30 runs `bypassPermissions`. Both halves were unsound:
  the observation was an artifact of comparing a gated command against one the CLI classifies as
  safe, and the dismissal would not have covered a default deployment if the observation had held.
  Re-measured with the same command shape in both turns and a guard requiring turn 1 to have been
  gated (`spikes/streaming-input-mode/approval-per-turn.mjs`): `canUseTool` is consulted on **every**
  turn, so a held process inherits no approvals and this matches `main`'s behaviour exactly.
  What remains true is unrelated to approvals: the persistent process fixes `permissionMode` at
  creation, so toggling it mid-session must call `setPermissionMode()` (verified working) rather than
  relying on the next turn spawning a fresh process.

## Success criteria

1. A background shell started in one turn is still running and still producing output after the
   next turn completes — verified by the promoted spike assertion.
2. The completing task's real status reaches the UI with no turn in flight.
3. A session that never starts background work spawns and exits exactly one process per turn, as
   today.
4. Abort settles the run rather than hanging it.
5. `npm run typecheck` and `npm run lint` clean; new pool tests pass.

**Test-runner note.** `server/claude-sdk-abort-race.test.ts` uses `mock.module`, so any aggregate
test command must include `--experimental-test-module-mocks`. Without it the file fails loudly
(exit 1) rather than being skipped, so a suite that checks its exit code cannot be fooled.

---

## Amendments after implementation (2026-07-28)

Claims in this spec that turned out to be wrong once the code met reality, plus the mechanisms that
had to be added and are described nowhere above. Recorded here so the document does not misdescribe
what shipped.

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
aborted session lingers up to 60 s instead of closing at once — goal 5 above has been amended to
state that bound explicitly rather than leave it contradicted. Implemented in commit `e15f9a1`.

**4. A reused process needed active option reconciliation, not just a fresh options object.** The
risk note above ("toggling it mid-session must call `setPermissionMode()`") was correct but was not
implemented in the first pass: `sdkOptions` reached only `createLiveSession`, so turn 2+ of a reused
session ran against turn 1's options *and* turn 1's captured `canUseTool` closure — a user switching
off `bypassPermissions` or unchecking a tool was still evaluated against the settings they had just
abandoned, and the resulting `permission_request` was written into the already-completed run's event
log. `runTurn` now compares the turn's options against the live process and either recreates it
(when there is no background work to protect — which is what the old code did at turn end anyway) or
reconfigures it in place.

Reconfiguring in place needs two distinct mechanisms, because refreshing our own state can only ever
*loosen*:

- **Loosening** — a tool the user has just *checked* — needs nothing from the CLI. It is not in the
  spawn-time allowlist, so the CLI asks us, and the per-session mutable `turnContext` (which the
  captured `canUseTool` reads for the writer and the allow/deny lists) answers with the current
  settings.
- **Tightening** — a tool the user has just *un-checked or disallowed* — cannot be done that way at
  all. The CLI holds the `--allowedTools` list it was spawned with and auto-approves from it
  **without ever calling `canUseTool`**, so our callback is not in the decision path. This is pushed
  into the CLI's own permission engine with the `applyFlagSettings()` control request, alongside
  `setPermissionMode()` / `setModel()`.

Measured against the real CLI 2.1.220 + SDK 0.3.165 in `spikes/streaming-input-mode/live-deny.mjs`,
with a background shell live throughout so the session was protected from recreation exactly as in
production:

| Step | Observed |
|---|---|
| Bash in the spawn allowlist, no rule pushed | `canUseTool consulted: 0` — auto-approved. This is the hole. |
| `applyFlagSettings({permissions:{ask:['Bash']}})`, then Bash | `canUseTool consulted: 1 ["Bash"]` — PROMPTED |
| `applyFlagSettings({permissions:{deny:['Bash']}})`, then Bash | `tool_result: is_error, "Permission to use Bash has been denied."` — DENIED by the CLI |
| `backgroundTasks()` afterwards | `true` — none of it killed the protected task |

The mapping ships to reproduce a freshly spawned process, which is what every turn used to get:
un-checked → `ask` (so the user keeps the ability to approve on demand, exactly as `canUseTool`'s
"on neither list" branch does); `disallowedTools` → `deny`. Both are sent as one complete
`permissions` object every time, because successive `applyFlagSettings` calls replace that object
rather than merging into it, and the layer is cleared with `permissions: null` — not `{}` — once
there is nothing left to restrict, so a re-checked tool becomes usable again instead of being stuck
for the life of a long-held process.

**Fail-closed rejection is the fallback, and applies to both permission-carrying fields.** If
`applyFlagSettings()` is missing (older SDK) or throws, and the desired layer adds a restriction the
process is not already under, the turn is **rejected** rather than run — the error reaches the user
as a `kind: 'error'` frame naming the session and telling them to let the background task finish or
stop it and retry. Same treatment as a `permissionMode` change that cannot be applied. A failure to
*relax* is logged and the turn proceeds: the only consequence is being asked when one need not have
been, which exposes nothing.

Two claims in an earlier revision of this amendment were wrong and are retracted: that "tightening
via `disallowedTools` does take effect" (false for a tool already in turn 1's spawn allowlist — the
CLI decides before consulting us, as the table's first row shows) and that closing and recreating the
process is the only complete fix (`applyFlagSettings()` exists in this SDK and is verified to
enforce). Implemented in the final-review fix round.

**5. Option fields could not see an edit-prompt fork drifting the process off its own key.** The
edit-prompt fork runs under the PARENT's `appSessionId` — the pool key — but the SDK announces the
branch's own provider session id mid-stream, so the process ends that turn serving the BRANCH while
the key still names the parent. `resume` is a spawn argument a running process ignores, and no option
field records the drift, so the parent's next turn would have been filed under the branch's
transcript. `servesADifferentConversation` (`server/claude-session-pool.js`) closes it by comparing
the requested `resume` id against the id the process last announced: mismatch ⇒ recreate, or refuse
the turn when background work forbids recreating.

That comparison rests on one **load-bearing assumption about the CLI**: a non-fork resume run
announces the id it RESUMED. True as of CLI 2.1.220 / SDK 0.3.165, and `sdk.d.ts` declares no message
type carrying a foreign session id — but it is not an invariant this code can enforce. If a future
CLI ever answered `--resume <id>` with a fresh id of its own, the recorded provider id would diverge
from every later turn's `resume` value and the check would return true forever. The symptom would be
severe and specific enough to recognise from a single bug report: **every turn on a session holding a
background shell refused with the drift sentence** ("has moved on to a branch of the conversation"),
while the same session with no background work silently recreated its process on every single turn.
Check this assumption first if those refusals ever appear.

**Attributing a background task to a user is fail-ACTIVE, deliberately.** A task is stamped, for its
whole life, with `session.taskOwner` as it stood when its `task_started` frame was routed — the owner
of the turn the CLI is running, or between turns of the last turn that ran, since that field is
refreshed per turn and never cleared. That covers the case the field exists for at no cost: after the
abort backstop vacates the slot, a task announced by the aborted turn's tail is still attributed to
the user who started it, because nobody has pushed a prompt since.

It is a guess in exactly one window — that tail announcing a task *after* the next prompt was pushed —
and there is no correlation field to settle it with, so all three candidate answers are wrong some of
the time. The running turn is taken because it is the turn the CLI is actually executing and so the
overwhelmingly likelier source of a `task_started`; the window logs the fact that it guessed.
`null` ("unknown owner") is not the cautious choice but the worst one: `emitBackgroundTaskEvent`
**broadcasts** an unknown owner's task, its summary and the absolute host path of its output to every
connected client, so declaring uncertainty exposes more, not less.

*Superseded:* a previous revision took the owner from the oldest outstanding **terminator debt**
instead. Whole-round review found that a debt, once armed, could stand forever — so every task the
running turn started while it stood was reported to the user who had already left. Same leak, aimed
at the common case instead of the rare one. The debt itself is gone; see the *Accepted risks* entry
below.

## Accepted risks

**Unbounded retention while a background task never terminates.** Decided deliberately, not
deferred: the pool has **no cap on the number of held sessions and no maximum hold time**. A session
is held for exactly as long as it has a live task, plus the 60 s idle grace period. A task that
never terminates on its own — `tail -f`, a dev server, a `while true` watcher — therefore holds its
~320 MB `claude` process for as long as the server runs. On a shared box like a30 several such
sessions could add up to real memory.

This is accepted because every alternative is worse for the user. An LRU cap or a maximum hold time
would evict by **killing the user's running work** — which is precisely the bug this whole design
exists to fix, reintroduced through the memory-saving path. Silently discarding a long-running task
because a timer expired is not a safer failure than using memory; it is the same silent loss in new
clothing.

Two things already bound the blast radius: the OS memory-pressure reaper stays enabled (see *Policy
decisions*), so a genuinely memory-starved box sheds tasks and the loss is reported through the
`background_task` frame rather than hidden; and the user can stop a task deliberately
(`stopTask()` — verified working, exposed by a UI that is an explicit non-goal here).

The agreed follow-up was to **warn**, not evict, and it has since shipped (`reportLongHeldTasks`,
`server/claude-session-pool.js`). While a session is holding its process for tracked tasks, a
periodic check (`HOLD_CHECK_INTERVAL_MS`, 60 s) re-examines the hold; once a task has held it past
`HOLD_WARN_AFTER_MS` (10 minutes) it is reported **once** — a `console.warn` naming every held task
and how long each has been held, for the operator, and a `background_task` advisory with
`status: 'running'` for the user who started it. The advisory is per task, not per check or per
session, so a long hold does not turn into a minute-by-minute stream of noise; ambient
`skip_transcript` housekeeping is counted for the operator but gets no user-facing row.

It still never evicts, closes, recreates or re-times anything: the decision recorded here is that
eviction is off the table, and the check is a pure observer of it. A periodic check rather than a
one-shot timer because nothing else ever reconsiders a hold — `closeIfIdle` clears the idle timer
while tasks are tracked and only an emptied task set re-arms it, so a task that never emits a
terminal frame (wedged, killed out of band, or a shape we mis-track) used to leave the process held
with no mechanism scheduled to notice, for the life of the server. The gap that was closed is not
the unbounded hold — that is accepted — it is that the hold used to be **invisible**.

**An aborted turn keeps its process for the idle grace period even with no background work.**
Deliberate, and not to be "optimised": the reason for the grace is that a `task_started` the CLI has
already sent may still be sitting unrouted in the SDK's async iterator, invisible to any check made
from outside the pool's drain loop (see amendment 3, and goal 5's bounded exception). So abort only
settles the turn and arms the deferred idle check, which re-reads live-task state when it fires, from
inside the drain loop's own ordering. The cost is one ~320 MB process held for up to 60 s after an
abort, released automatically and never accumulating. **Document it; do not change it** — shortening
or removing the grace reopens exactly the race this design closed, in which abort kills a background
task that had just started.

**An abandoned turn's terminator can truncate the next turn's answer.** `ABORT_SETTLE_FALLBACK_MS`
settles an aborted turn five seconds after an acknowledged interrupt that produced nothing, so its
premise is that no terminator is coming. It is a guess, and when it is wrong the CLI's real terminator
arrives while the *next* turn is live — indistinguishable from that turn's own, because no SDK message
carries a turn-correlation field (`SDKResultMessage` has `uuid`, `session_id`, `num_turns`). The rule
adopted is that **the first `result` always settles whatever turn holds the slot**, so the cost of a
wrong guess is one turn's answer truncated (or, if it had emitted nothing yet, lost) and its run
reported complete.

Accepted after ranking it against the alternative that was tried and removed. That alternative — a
terminator "debt" plus a swallow branch, built on the premise that the terminator *is* still coming —
took the opposite premise at the same moment: whenever the fallback's own premise held, the debt was
never repaid, and nothing expired it. The next turn was swallowed whole with no log line, its `result`
was consumed as the repayment so its promise never settled and the slot was never vacated, and every
later message on that session was refused. Pressing Stop settled the hung turn and armed a fresh debt,
so the turn after that was swallowed too. That is a bricked session traded for a rare truncation, and
it is the wrong direction: **a dead turn's tail leaking into a live turn is far less bad than a live
turn being swallowed**, and the second one must be impossible rather than merely unlikely.

What remains of the debt is an observation, `owedTerminator` — one nullable record, armed only by the
fallback, cleared by the first `result` the session sees afterwards or with the session itself. It
never withholds a frame or a terminator from a live turn. It is read for two things only: to absorb a
terminator arriving *between* turns, the one window where "this is not the live turn's result" is a
fact rather than a guess (and where forwarding it would destroy, `IDLE_GRACE_MS` early, a process the
user may be about to re-use); and to make both remaining guesses observable — one `console.warn` when
a turn is settled while a terminator was outstanding, carrying the `appSessionId` and how many frames
that turn had delivered (zero = total loss, non-zero = partial), and one when a task is attributed in
the ambiguous window. By measurement the whole branch is the rare one: an interrupted turn terminates
within milliseconds (`spikes/streaming-input-mode/interrupt-result.mjs`), so the fallback fires only in
the unmeasured slow-unwind case.

**Unmeasured interaction with the user's own `settings.json`.** ccui spawns with
`settingSources = ['project', 'user', 'local']` (`server/claude-sdk.js:262`), so a freshly spawned
process also reads whatever `allow` rules live in the user's own settings files, and the live
flag-settings `permissions` layer this pool pushes sits above those files. Before this pool existed,
a tool the user un-checked in ccui but had `allow`-listed in their own `settings.json` was still
auto-approved by a freshly spawned process (turn-per-process, so the file layer was the only one in
play); now the same tool gets an `ask` rule pushed on top and the process PROMPTS instead. Not
measured against a real `settings.json` with such a rule. The direction is safe either way — a
prompt is not a denial, and the user retains the ability to approve on demand — but the behaviour
change itself has not been verified end to end.
