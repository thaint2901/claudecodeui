// server/claude-session-pool.js
import { createInputStream } from './claude-session-input-stream.js';

/**
 * Owns the lifetime of live `claude` CLI processes, one per app session.
 *
 * Why this exists: ccui used to create a `query()` per turn, so the subprocess
 * exited at turn end and took any background shell with it. The CLI only
 * reaps background tasks once its input is closed, so this pool keeps the input
 * stream open while background work is live and closes it otherwise. A session
 * that never starts background work therefore behaves exactly as before.
 *
 * That hold is deliberately unbounded — nothing here ever ends a user's running
 * task — so it is instead REPORTED once it gets long: see
 * `HOLD_WARN_AFTER_MS`/`reportLongHeldTasks`.
 *
 * Deliberately knows nothing about normalized messages or websockets: callers
 * pass `onMessage` / `onBetweenTurnMessage` and keep translation to themselves.
 */

const IDLE_GRACE_MS = 60000;

/**
 * How often a session that is holding its process open for background work
 * re-examines that hold, and how long one task may hold it before the operator
 * and the user are told.
 *
 * This check exists ONLY to report. It never closes, evicts, recreates or
 * re-times anything, by an explicit ruling: every eviction rule — an LRU cap, a
 * maximum hold time — kills the user's running work, which is the exact bug this
 * pool was built to fix. So an unbounded hold stays an accepted risk, and the
 * gap being closed here is that it used to be an INVISIBLE one.
 *
 * Why a periodic check is needed at all rather than a one-shot timer: nothing
 * else ever reconsiders a hold. `closeIfIdle` CLEARS the idle timer while tasks
 * are tracked and only `armIdleTimerIfIdle` re-arms it, which requires the set
 * to become empty — so a task that never emits a terminal frame (wedged, killed
 * out of band, or a shape we mis-track) left the process held with no mechanism
 * scheduled to notice, for the life of the server. An operator found out at OOM.
 */
const HOLD_CHECK_INTERVAL_MS = 60000;
const HOLD_WARN_AFTER_MS = 600000;

/**
 * How long an aborted turn may keep the slot without a terminator.
 *
 * The normal route is the terminator: an interrupted turn emits a `result` with
 * `subtype: 'error_during_execution'` within milliseconds (measured:
 * `spikes/streaming-input-mode/interrupt-result.mjs`), and that is what settles
 * the turn. This covers the residual case of a CLI that ACKNOWLEDGED the
 * interrupt and then emitted nothing — unmeasured, and unfalsifiable from in
 * here, which is the point: a `result` that never comes cannot be waited on
 * forever or the caller's promise never settles and the run sits in
 * "processing" for the life of the process.
 *
 * Explicitly NOT the backstop for a FAILED interrupt, however tempting that
 * reading is: a rejected `interrupt()` never marks the turn (see
 * `interruptTurn`), so it never arms this timer — the stop did not happen, the
 * run is still the user's run, and it terminates itself normally.
 */
const ABORT_SETTLE_FALLBACK_MS = 5000;

/**
 * Option fields whose value must match the live process for a turn to be
 * allowed to reuse it, split by whether a RUNNING process can be reconfigured.
 *
 * `LIVE_APPLICABLE_*` have a real mid-session mechanism: `setPermissionMode()`,
 * `setModel()` and `applyFlagSettings()` are SDK control requests
 * (streaming-input-only — which is exactly the mode this pool put us in), and a
 * LOOSENED allow list additionally reaches our own approval callback through the
 * shared `turnContext` object rather than through the closure the SDK captured
 * on turn 1.
 *
 * `RECREATE_ONLY_*` can only be honoured by a fresh `query()`: `cwd` is fixed at
 * spawn, and a fork needs its own process (there is no fork-mid-stream control
 * request). `effort` belongs here for a narrower reason than "fixed at spawn":
 * `applyFlagSettings` does expose an `effortLevel` key, but its domain is
 * SMALLER than the `effort` query option — `'low'|'medium'|'high'|'xhigh'`
 * versus those plus `'max'` and numeric values — so a live push would silently
 * mis-apply the values it cannot express. Reconciling only the overlapping
 * subset would be worse than not reconciling: it would succeed for four values
 * and quietly diverge for the rest. When background work is live we refuse to
 * close, so these changes are reported and skipped rather than silently
 * pretended-applied.
 *
 * Deliberately NOT relevant:
 * - `resume`: an artifact of process creation, not a behaviour knob. A live
 *   process is by definition already on its session, and turn 2 of a brand-new
 *   session always gains a `resume` value that turn 1 lacked — treating that as
 *   a change would recreate (or warn) on every such turn for no benefit.
 * - `env` / `mcpServers` / `hooks` / `canUseTool`: rebuilt per turn by
 *   `mapCliOptionsToSDK`, so they differ by identity every time; MCP-server
 *   parity across turns is an explicit non-goal of the design spec.
 */
const LIVE_APPLICABLE_OPTION_FIELDS = ['permissionMode', 'model', 'allowedTools', 'disallowedTools'];
const RECREATE_ONLY_OPTION_FIELDS = ['cwd', 'effort', 'forkSession', 'resumeSessionAt'];
const RELEVANT_OPTION_FIELDS = [...LIVE_APPLICABLE_OPTION_FIELDS, ...RECREATE_ONLY_OPTION_FIELDS];

/**
 * Recreate-only fields that a process CONSUMES as it is created, and which are
 * therefore not a pending change once it exists — the same argument the `resume`
 * exclusion above makes, one step further along: `resume` is excluded outright
 * because it is never a behaviour knob, whereas forking IS one, but only in one
 * direction.
 *
 * A live process created with `forkSession` is already the branch. Keeping the
 * creation value in the snapshot made every LATER ordinary turn on that session
 * compare `undefined` against `true` forever — a needless recreate when there
 * was nothing to protect, and a `console.warn` on every single turn when there
 * was. So the snapshot records them as already-consumed (null) at creation,
 * which leaves the change detectable in the direction that still matters: a
 * session that is NOT a fork receiving a fork request still differs, still
 * recreates, and (when a background task forbids that) is still refused.
 *
 * What this must NOT be read as: "a fork-created process is always safe to
 * reuse". `forkSession` was also, accidentally, the only field that noticed the
 * EDIT-PROMPT fork drifting a process off its pool key's conversation — see
 * `servesADifferentConversation`, which is what actually covers that, by
 * identity rather than by flag.
 */
const CONSUMED_AT_CREATION_OPTION_FIELDS = ['forkSession', 'resumeSessionAt'];

/**
 * Synthetic reason reported beside the recreate-only FIELD names when the live
 * process is no longer on the conversation the turn continues. Not an option
 * field: no option records it, because the drift happens mid-stream inside the
 * CLI (see `servesADifferentConversation`).
 *
 * The `reason:` prefix is not decoration. This value shares one flat namespace
 * with the option field names in `pendingFreshProcessReasons`' output, and both
 * are consumed by string membership (`FRESH_PROCESS_REQUIRED_REASONS.has`,
 * `blocked.includes`). A bare `'conversation'` would silently MERGE with a future
 * recreate-only option that happened to be named `conversation` — the drift
 * message would then be emitted for a plain option change, and vice versa, with
 * nothing anywhere to notice. No option field name can contain a colon, so the
 * prefix makes the collision impossible rather than merely unlikely.
 */
export const CONVERSATION_DRIFT_REASON = 'reason:conversation-drift';

/**
 * Stamped as `.code` on the error `runTurn` throws when a turn arrives while
 * another is genuinely in flight on the same session.
 *
 * Exists so the caller can tell that refusal apart from a real failure without
 * matching on the message text. It is a REFUSAL: nothing was started and nothing
 * is broken, so `queryClaudeSDK` reports it the same way it reports a
 * background-task-held session — a coded `protocol_error` plus the terminal
 * `complete` — instead of letting the internal sentence below reach the user as
 * an `error` frame.
 *
 * Narrow by design: a turn that arrives while an ABORTED one is still settling
 * waits for it (see `runTurn`), so what is left here is two callers running at
 * once on one session — in practice a REST `/api/agent` call landing on a session
 * the websocket path is already running, since only the websocket path is
 * serialised by `chatRunRegistry`.
 */
export const TURN_IN_FLIGHT_ERROR_CODE = 'SESSION_TURN_ALREADY_RUNNING';

function turnInFlightError(appSessionId) {
  const error = new Error(`Session "${appSessionId}" already has a turn in flight`);
  error.code = TURN_IN_FLIGHT_ERROR_CODE;
  return error;
}

/** @type {Map<string, LiveSession>} */
const live = new Map();

/**
 * @typedef {object} Turn
 * @property {Function} onMessage
 * @property {Promise<object>} promise - What `runTurn` returns to its caller.
 * @property {Function} resolve
 * @property {Function} reject
 * @property {Promise<void>} settled - Resolves when this turn leaves the slot,
 *   by any route. Awaited by a turn that arrives while an aborted one is still
 *   settling, so a user who presses Stop and re-sends immediately does not get
 *   a "turn in flight" error.
 * @property {Function} notifySettled
 * @property {boolean} aborted - The user pressed Stop. The turn keeps the slot
 *   until its terminator arrives, but its frames stop reaching the UI.
 * @property {NodeJS.Timeout | null} abortSettleTimer
 * @property {boolean} promptSent - False while the turn has only RESERVED the
 *   slot (claimed before reconciliation, which may still reject or recreate the
 *   process). Nothing may be routed to, or settled on, a reserved turn.
 * @property {unknown} taskOwner - This turn's opaque owner token, kept on the
 *   turn as well as on the session so that a task announced by this turn's TAIL
 *   — after the abort backstop vacated the slot — can still be attributed to it.
 */

/**
 * @typedef {object} LiveSession
 * @property {string} appSessionId
 * @property {object} query
 * @property {ReturnType<typeof createInputStream>} input
 * @property {Map<string, LiveTask>} liveTaskIds - Keyed by task id. A Map rather
 *   than a Set because a task lost with the process has to be REPORTED, and the
 *   only human label for it (`task_started.description`) arrives on the frame
 *   that starts it and nowhere else. A parallel map beside a Set would be two
 *   structures to keep in sync, which is where divergence bugs live.
 * @property {Turn | null} currentTurn
 * @property {Function} onBetweenTurnMessage - Called `(message, { taskOwner })`.
 *   `taskOwner` is the owner recorded for a task that this very message settled,
 *   and null for everything else — read from the task record because `trackTask`
 *   has already removed it by the time this runs.
 * @property {Function | null} onTaskLost - Told about each task that died with
 *   the process, as `(event, { taskOwner })`. Refreshed per turn like
 *   `onBetweenTurnMessage`, so the report reaches whoever is currently watching
 *   this session — but `taskOwner` comes from the TASK, not from the turn that
 *   installed this callback.
 * @property {Function | null} onHoldWarning - Told once about each task that has
 *   held this process open past `HOLD_WARN_AFTER_MS`, as `(event, { taskOwner })`.
 *   Refreshed per turn for the same reason as `onTaskLost`. Advisory only: the
 *   pool takes no action on the hold before or after calling it.
 * @property {unknown} taskOwner - Opaque token for the CURRENT turn's owner,
 *   refreshed per turn exactly like the callbacks above. Its only use is being
 *   stamped onto each task this session starts; the pool never interprets it.
 * @property {string | null} providerSessionId - The provider-native session id
 *   the process is currently on, as last announced in its own message stream.
 *   Null until it announces one. The pool otherwise knows nothing about provider
 *   ids; this exists only to notice a process that has drifted off its key's
 *   conversation (see `servesADifferentConversation`).
 * @property {object} optionSnapshot - Normalized `RELEVANT_OPTION_FIELDS` as
 *   currently in force on this process (creation values, amended by whatever
 *   control requests have since been applied), except for the fields creation
 *   itself consumed — see `creationSnapshot`.
 * @property {string[]} spawnAllowedTools - The `--allowedTools` list this process
 *   was spawned with, which the CLI auto-approves from for its whole lifetime.
 * @property {{ ask: string[], deny: string[] } | null} appliedPermissions - The
 *   flag-settings `permissions` layer last successfully pushed into the process.
 * @property {object | null} turnContext - Mutable object the caller's captured
 *   callbacks (`canUseTool`, hooks) read from. Updated IN PLACE on reuse so
 *   turn 1's captured closures act on turn N's writer and settings.
 * @property {NodeJS.Timeout | null} idleTimer
 * @property {NodeJS.Timeout | null} holdCheckTimer - Exists exactly while this
 *   session is holding its process open for tracked tasks. Kept in sync from one
 *   place (`syncHoldCheckTimer`) and cleared on every death path, because a timer
 *   that outlives its session is the same class of defect as the slot that
 *   outlived its turn.
 * @property {boolean} dead
 * @property {unknown[]} owedTerminators - One entry per `result` message still
 *   expected for a turn the abort fallback settled without one, holding that
 *   turn's `taskOwner`, oldest first. A queue rather than a flag: a second
 *   fallback can fire while a debt is outstanding (turn 2 aborted too), and a
 *   flag would silently drop one debt, letting exactly the frame it was meant to
 *   swallow through. It carries the owner rather than being a bare count because
 *   a single-conversation CLI serialises turns, so everything up to and including
 *   the owed terminator belongs to the turn that owes it — which is what lets a
 *   task announced by that tail be attributed correctly (see
 *   `ownerForNewlyStartedTask`). Same invariant `routeMessage`'s swallow branch
 *   already relies on, not a second guess about it.
 */

/**
 * @typedef {object} LiveTask
 * @property {string | null} description - The CLI's own short human label for
 *   the task (measured: `"Echo t1-t10 with delays"` —
 *   `spikes/streaming-input-mode/task-classification.mjs`). Null when the frame
 *   carried none, so a report can say "a background task" instead of "null".
 * @property {boolean} skipTranscript - The task is ambient housekeeping. Still
 *   tracked (closing the process would kill it too) but deliberately kept out of
 *   the transcript, exactly as its `task_notification` already is.
 * @property {number} startedAt - `Date.now()` when its `task_started` frame was
 *   routed. The only clock available: no SDK frame carries the task's own start
 *   time, and the hold that matters is how long WE have been keeping the process
 *   alive for it.
 * @property {boolean} holdReported - This task's long-hold advisory has already
 *   gone out. Per task, not per session and not per check: a warning that repeats
 *   every minute is noise, and noise is how the previous silent failure hid.
 * @property {unknown} owner - Whoever the caller says this task belongs to,
 *   captured from `session.taskOwner` when its `task_started` frame was routed
 *   and handed back with every report about it. Per TASK because a background
 *   shell outlives turns, and the next turn on a shared session can be someone
 *   else's: an owner read off "the current turn" addresses the latest user, which
 *   is the same defect as telling everyone, narrowed to one wrong recipient.
 *   Opaque to the pool — it is compared and interpreted only by the caller.
 */

/** Order-insensitive for lists, so a reshuffled allowlist is not a "change". */
function normalizeOptionValue(value) {
  if (Array.isArray(value)) {
    return [...value].map(String).sort();
  }
  return value === undefined ? null : value;
}

function snapshotOptions(sdkOptions) {
  /** @type {Record<string, unknown>} */
  const snapshot = {};
  for (const field of RELEVANT_OPTION_FIELDS) {
    snapshot[field] = normalizeOptionValue(sdkOptions?.[field]);
  }
  return snapshot;
}

/**
 * The snapshot to store on a process at the moment it is created: what it was
 * spawned with, minus the fields spawning itself consumed (see
 * `CONSUMED_AT_CREATION_OPTION_FIELDS`).
 */
function creationSnapshot(sdkOptions) {
  const snapshot = snapshotOptions(sdkOptions);
  for (const field of CONSUMED_AT_CREATION_OPTION_FIELDS) {
    snapshot[field] = null;
  }
  return snapshot;
}

function differingFields(fields, current, next) {
  return fields.filter((field) => JSON.stringify(current[field]) !== JSON.stringify(next[field]));
}

/**
 * True when the live process is no longer on the conversation this turn asks to
 * continue, so reusing it would write the turn into someone else's transcript.
 *
 * The case that makes this necessary is the EDIT-PROMPT fork. It runs under the
 * PARENT's `appSessionId` — the pool key — but the SDK announces the branch's own
 * provider session id mid-stream, and the run registry deliberately leaves the
 * parent's app-id→provider-id mapping intact and inserts a separate branch row.
 * So the process ends the turn serving the BRANCH while the pool key still names
 * the parent. `resume` is a spawn argument: a process that is already running
 * ignores it, so nothing else corrects this. Explicit `/fork` is unaffected —
 * it runs under the fork's own new app session id, so key and conversation agree.
 *
 * An IDENTITY comparison, not a field comparison, which is why it can succeed
 * where the `resume` field exclusion documented at the top of this file cannot:
 * turn 2 of a brand-new session gains a `resume` value turn 1 lacked, but that
 * value EQUALS the id the process announced, so nothing looks changed. Both
 * sides must be known before a mismatch is claimed — a caller that asks for no
 * particular conversation is asking for the one it is already on.
 */
function servesADifferentConversation(session, sdkOptions) {
  const requested = sdkOptions?.resume;
  const actual = session.providerSessionId;
  return typeof requested === 'string' && requested !== ''
    && typeof actual === 'string' && actual !== ''
    && requested !== actual;
}

/**
 * Derives the flag-settings `permissions` layer a live process needs so that
 * THIS turn's tool settings are the ones actually enforced.
 *
 * The problem it solves: the CLI keeps the `--allowedTools` allowlist it was
 * spawned with and auto-approves against it WITHOUT calling `canUseTool`
 * (measured — `spikes/streaming-input-mode/live-deny.mjs` STEP 1). So refreshing
 * `turnContext.allowedTools` cannot tighten anything: our callback is never
 * reached for a tool the CLI already considers allowed. Only a rule pushed into
 * the CLI's own permission engine can.
 *
 * The mapping is chosen to reproduce a freshly spawned process exactly, which is
 * what every turn used to get before this pool existed:
 *
 * - A tool the user has since UN-CHECKED means "prompt me" in ccui — `canUseTool`
 *   falls through to a `permission_request` for anything on neither list. So it
 *   becomes an `ask` rule, which the CLI routes back through `canUseTool`
 *   (measured: STEP 4 → PROMPTED). A `deny` here would be stricter than main and
 *   would take away the user's ability to approve on demand.
 * - A tool on `disallowedTools` means "never" — `canUseTool` returns `deny`. So it
 *   becomes a `deny` rule, which the CLI refuses outright (measured: STEP 6 →
 *   "Permission to use Bash has been denied."). Pushing it is what makes a tool
 *   ALREADY in the spawn allowlist actually disallowable mid-session.
 * - A tool the user has since CHECKED needs nothing here: it is not in the spawn
 *   allowlist, so the CLI asks us, and `turnContext.allowedTools` says yes.
 *
 * Returns `null` when no flag layer is needed, so the caller can clear ours and
 * fall back to the user's own settings files rather than leaving an empty object
 * sitting above them.
 */
function derivePermissionOverrides(spawnAllowedTools, nextSnapshot) {
  const nextAllowed = new Set(nextSnapshot.allowedTools ?? []);
  const deny = [...(nextSnapshot.disallowedTools ?? [])];
  const denySet = new Set(deny);
  const ask = spawnAllowedTools.filter((entry) => !nextAllowed.has(entry) && !denySet.has(entry));

  if (ask.length === 0 && deny.length === 0) {
    return null;
  }
  return { ask, deny };
}

/**
 * True when `next` restricts something `applied` did not. Used to decide whether
 * a FAILED `applyFlagSettings` must reject the turn: failing to install a new
 * restriction means running under permissions the user has already revoked, so
 * that is fail-closed. Failing to install a pure relaxation only means the user
 * gets asked when they need not have been, which is safe to proceed with.
 */
function addsRestriction(applied, next) {
  const appliedAsk = new Set(applied?.ask ?? []);
  const appliedDeny = new Set(applied?.deny ?? []);
  // A `deny` is stricter than an `ask`, so an entry moving from ask to deny is a
  // tightening even though it was already restricted.
  return (
    (next?.deny ?? []).some((entry) => !appliedDeny.has(entry))
    || (next?.ask ?? []).some((entry) => !appliedAsk.has(entry) && !appliedDeny.has(entry))
  );
}

/**
 * Pushes `session`'s tool permissions into the RUNNING process's flag-settings
 * layer. No-op when the derived layer already matches what was last applied.
 *
 * `applyFlagSettings` shallow-merges top-level keys, so a second call replaces
 * the whole `permissions` object — the derived layer is therefore always sent
 * complete, never as a delta, and cleared with `null` rather than `{}`.
 */
async function applyToolPermissionsToLiveProcess(session, nextSnapshot) {
  const next = derivePermissionOverrides(session.spawnAllowedTools, nextSnapshot);
  if (JSON.stringify(next) === JSON.stringify(session.appliedPermissions)) {
    return true;
  }

  const tightening = addsRestriction(session.appliedPermissions, next);

  if (typeof session.query.applyFlagSettings !== 'function') {
    if (tightening) {
      throw new Error(
        `Cannot apply the current tool permissions to the live Claude session "${session.appSessionId}": `
        + 'this SDK build exposes no applyFlagSettings() control request, and the process must stay alive '
        + 'for its background work. Refusing to run the turn, because the CLI would auto-approve tools '
        + 'you have just turned off. Wait for the background task to finish, or stop it, and retry.',
      );
    }
    console.warn('[ClaudeSessionPool] no applyFlagSettings(); a relaxed tool permission cannot reach the live process', {
      appSessionId: session.appSessionId,
    });
    return false;
  }

  try {
    await session.query.applyFlagSettings({ permissions: next });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (tightening) {
      throw new Error(
        `Cannot apply the current tool permissions to the live Claude session "${session.appSessionId}" `
        + `(${detail}). The process must stay alive for its background work, so refusing to run the turn `
        + 'rather than let the CLI auto-approve tools you have just turned off. Wait for the background '
        + 'task to finish, or stop it, and retry.',
      );
    }
    console.warn('[ClaudeSessionPool] applyFlagSettings() failed while relaxing tool permissions', {
      appSessionId: session.appSessionId,
      error: detail,
    });
    return false;
  }

  session.appliedPermissions = next;
  return true;
}

/**
 * Reconfigures a RUNNING process to the new turn's options.
 *
 * Only reached when the session has live background work, i.e. when closing and
 * recreating would kill the very task this pool exists to protect.
 *
 * Both permission-carrying fields are fail-closed: a failure to apply
 * `permissionMode` or the tool permissions rejects the turn instead of running
 * it, because either one silently proceeding would evaluate the turn against
 * settings the user has already abandoned — `bypassPermissions` skips the
 * approval callback entirely inside the CLI, and the CLI's spawn-time allowlist
 * auto-approves without calling it. `model` is not a safety boundary, so a
 * failure there is logged and the turn proceeds.
 */
async function applyLiveOptionChanges(session, nextSnapshot) {
  const changed = differingFields(LIVE_APPLICABLE_OPTION_FIELDS, session.optionSnapshot, nextSnapshot);

  if (changed.includes('permissionMode')) {
    const mode = nextSnapshot.permissionMode ?? 'default';
    if (typeof session.query.setPermissionMode !== 'function') {
      throw new Error(
        `Cannot switch the live Claude session "${session.appSessionId}" to permission mode "${mode}": `
        + 'this SDK build exposes no setPermissionMode() control request, and the process must stay '
        + 'alive for its background work. Refusing to run the turn under the previous mode.',
      );
    }
    await session.query.setPermissionMode(mode);
  }

  if (changed.includes('model')) {
    try {
      await session.query.setModel?.(nextSnapshot.model ?? undefined);
    } catch (error) {
      console.warn('[ClaudeSessionPool] setModel() failed; the live session keeps its previous model', {
        appSessionId: session.appSessionId,
        model: nextSnapshot.model,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Loosening the tool lists needs no control request — `canUseTool` reads them
  // per invocation from `session.turnContext`, which the caller refreshes every
  // turn. TIGHTENING them does, because the CLI auto-approves from its
  // spawn-time allowlist without ever calling us. This pushes the current lists
  // into the CLI's own permission engine; on failure it throws, which rejects
  // the turn rather than running it under permissions the user has revoked.
  let permissionsApplied = true;
  if (changed.includes('allowedTools') || changed.includes('disallowedTools')) {
    permissionsApplied = await applyToolPermissionsToLiveProcess(session, nextSnapshot);
  }

  for (const field of changed) {
    // A skipped or failed (relaxation) push leaves `appliedPermissions` behind
    // `nextSnapshot`. Advancing `optionSnapshot` here anyway would make the
    // NEXT turn's identical request compare as "unchanged" and never retry the
    // push — the process would keep enforcing the stale rule for its whole
    // life. Leaving these two fields stale keeps them showing up in `changed`
    // (both here and in the caller's outer diff) until a push actually lands.
    if (!permissionsApplied && (field === 'allowedTools' || field === 'disallowedTools')) {
      continue;
    }
    session.optionSnapshot[field] = nextSnapshot[field];
  }
}

function clearIdleTimer(session) {
  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }
}

function clearHoldCheckTimer(session) {
  if (session.holdCheckTimer) {
    clearInterval(session.holdCheckTimer);
    session.holdCheckTimer = null;
  }
}

/**
 * Reports any task that has now held this process open past the threshold, and
 * does nothing else. Read this as a pure observer: it must not close, destroy,
 * recreate or re-time the session it is describing.
 */
function reportLongHeldTasks(session) {
  if (session.dead) {
    // Belt and braces. Every death path clears this timer, but "a timer fired
    // for a session that no longer exists" is this file's oldest defect shape,
    // so the callback refuses a dead session as well as being cancelled by one —
    // and `drain` deliberately leaves `liveTaskIds` populated on death, so a
    // leaked interval would otherwise report a hold on a process that is gone.
    clearHoldCheckTimer(session);
    return;
  }

  const now = Date.now();
  /** @type {Array<[string, LiveTask]>} */
  const due = [];
  let oldestStartedAt = now;
  for (const [taskId, task] of session.liveTaskIds) {
    oldestStartedAt = Math.min(oldestStartedAt, task.startedAt);
    if (!task.holdReported && now - task.startedAt >= HOLD_WARN_AFTER_MS) {
      task.holdReported = true;
      due.push([taskId, task]);
    }
  }

  if (due.length === 0) {
    return;
  }

  console.warn('[ClaudeSessionPool] this session is still holding a Claude CLI process open for background work; nothing will end it automatically', {
    appSessionId: session.appSessionId,
    heldTaskCount: session.liveTaskIds.size,
    oldestHeldForMs: now - oldestStartedAt,
    // Every held task, not just the newly-due ones: the question an operator is
    // actually asking is "what is keeping this subprocess alive", and a list
    // filtered to whatever crossed the line this minute answers a different one.
    tasks: [...session.liveTaskIds].map(([taskId, task]) => ({
      taskId,
      description: task.description,
      heldForMs: now - task.startedAt,
    })),
  });

  for (const [taskId, task] of due) {
    // Same rule `reportLostTasks` applies: ambient housekeeping is counted for
    // the operator but never put in the conversation, since the user did not ask
    // for it and cannot act on it.
    if (task.skipTranscript) {
      continue;
    }
    try {
      session.onHoldWarning?.(
        { taskId, description: task.description, heldForMs: now - task.startedAt },
        { taskOwner: task.owner },
      );
    } catch (reportError) {
      // One sink throwing must not cost the remaining tasks their advisory, for
      // the same reason `reportLostTasks` guards each call: the caller's callback
      // reaches a websocket fan-out.
      console.error('[ClaudeSessionPool] failed to report a long-held background task', {
        appSessionId: session.appSessionId,
        taskId,
        error: reportError instanceof Error ? reportError.message : String(reportError),
      });
    }
  }
}

/**
 * Makes the hold check exist exactly while this session has tracked tasks.
 *
 * One place rather than an arm/clear call beside each mutation of
 * `liveTaskIds`: three separate call sites is how that invariant drifts, and the
 * cost of re-deriving it is a `Map.size` read.
 */
function syncHoldCheckTimer(session) {
  if (session.dead || session.liveTaskIds.size === 0) {
    clearHoldCheckTimer(session);
    return;
  }
  if (session.holdCheckTimer) {
    return;
  }
  session.holdCheckTimer = setInterval(() => reportLongHeldTasks(session), HOLD_CHECK_INTERVAL_MS);
  // A repeating timer keeps the event loop alive by itself, so a missed clear
  // would stop the server from ever exiting. `unref` makes the worst case a
  // stale timer instead of a hung process; the clears are still what cancel it.
  session.holdCheckTimer.unref?.();
}

/**
 * Removes `session` from `live` only if it is still the entry stored at its
 * own key. `destroy()` and `drain()`'s `finally` both race a superseding
 * session created for the same `appSessionId` (e.g. `closeSession()` runs
 * synchronously, but the old session's async generator does not actually
 * finish until a later microtask) — an unconditional `live.delete()` would
 * delete the NEW session's entry instead of a stale one that's already gone.
 */
function removeFromLiveIfCurrent(session) {
  if (live.get(session.appSessionId) === session) {
    live.delete(session.appSessionId);
  }
}

/**
 * The bookkeeping every route out of a live session's life owes, in one place:
 * flag it dead, cancel both of its timers, and take it out of the live map if it
 * is still the entry stored there.
 *
 * Shared by `destroy()` (we closed it) and `drain()`'s `finally` (it ended on its
 * own, which never goes through `destroy`). Those two used to do the same steps
 * independently, and the hold-check timer had already been added to only one of
 * them once — a fifth step landing in one copy and not the other is the failure
 * this collapses. What each caller keeps for itself is what makes it different:
 * `destroy` also tears the process down, `drain` reads `dead` BEFORE calling this
 * (that read is how it tells "we closed it" from "it died"), rejects its turn
 * first so the caller's promise settles before anything reports, and reports lost
 * tasks after — deliberately last, so nothing in reporting can leave a dead
 * session in the live map.
 */
function markSessionDead(session) {
  session.dead = true;
  clearIdleTimer(session);
  clearHoldCheckTimer(session);
  removeFromLiveIfCurrent(session);
}

function destroy(session) {
  markSessionDead(session);
  session.input.close();
  try {
    session.query.close?.();
  } catch (error) {
    console.warn('[ClaudeSessionPool] close() failed', {
      appSessionId: session.appSessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Live-task bookkeeping, driven by typed SDK messages rather than tool_result
 * prose. A missed announcement would leave the set empty and let us close the
 * process — killing the very task we are trying to protect — so this must not
 * depend on string matching.
 */
function trackTask(session, message) {
  const settledTaskOwner = applyTaskLifecycle(session, message);
  // The hold check's lifetime follows `liveTaskIds`, so it is re-derived
  // wherever that map is touched — arming when the first task registers and
  // clearing when the last one settles.
  syncHoldCheckTimer(session);
  return settledTaskOwner;
}

/**
 * Returns the `owner` of a task this message just SETTLED, or null.
 *
 * The return value exists because the record is gone by the time any sink runs:
 * `routeMessage` tracks before it forwards (task lifecycle must be applied even
 * for messages that are otherwise suppressed), so a sink that wanted to know who
 * a settling task belonged to could no longer look it up.
 */
/**
 * Who a task announced RIGHT NOW belongs to.
 *
 * Normally the turn in the slot — `session.taskOwner`. But the abort backstop
 * vacates the slot while the aborted turn is still unwinding inside the CLI, and
 * task lifecycle frames are deliberately exempt from the swallow that covers the
 * rest of that tail (they are session-scoped, and dropping one would let the pool
 * close a process with a live shell in it). So a `task_started` can arrive from a
 * turn that no longer holds the slot, and reading the current field would hand
 * one user's background shell — its summary and its absolute output path — to
 * whoever happened to send the next message.
 *
 * The outstanding debt resolves it without any new guess: a single-conversation
 * CLI serialises turns, so everything up to and including the owed terminator
 * belongs to the turn that owes it. That is the same invariant `routeMessage`'s
 * swallow branch is built on. Oldest debt first, for the same reason.
 */
function ownerForNewlyStartedTask(session) {
  if (session.owedTerminators.length > 0) {
    return session.owedTerminators[0];
  }
  return session.taskOwner ?? null;
}

function applyTaskLifecycle(session, message) {
  if (message?.type !== 'system') {
    return null;
  }
  if (message.subtype === 'task_started' && typeof message.task_id === 'string') {
    // `description` is the only label this frame carries that a human can read:
    // `task_started` has no `output_file` (only `task_notification` does), so a
    // task lost with the process can be named but never located.
    session.liveTaskIds.set(message.task_id, {
      description: typeof message.description === 'string' && message.description ? message.description : null,
      skipTranscript: message.skip_transcript === true,
      startedAt: Date.now(),
      holdReported: false,
      // Whoever's turn started it, for the whole life of the task. A task the
      // pool never saw start (no `task_started` routed) has no record at all, so
      // its settlement reports a null owner — the caller's documented
      // unknown-owner path, and deliberately NOT a guess at the current turn's
      // user, which is the mistake this field removes.
      owner: ownerForNewlyStartedTask(session),
    });
    return null;
  }
  if (message.subtype === 'task_notification' && typeof message.task_id === 'string') {
    const settling = session.liveTaskIds.get(message.task_id);
    session.liveTaskIds.delete(message.task_id);
    return settling?.owner ?? null;
  }
  if (message.subtype === 'task_updated' && typeof message.task_id === 'string') {
    const status = message.patch?.status;
    if (status === 'completed' || status === 'failed' || status === 'killed') {
      const settling = session.liveTaskIds.get(message.task_id);
      session.liveTaskIds.delete(message.task_id);
      return settling?.owner ?? null;
    }
  }
  return null;
}

/** Closes the session unless background work still needs the process alive. */
function closeIfIdle(session) {
  if (session.dead || session.currentTurn) {
    return;
  }
  if (session.liveTaskIds.size > 0) {
    clearIdleTimer(session);
    return;
  }
  destroy(session);
}

/**
 * Builds the turn record. Both settlement handles exist by the time this
 * returns — `new Promise`'s executor runs synchronously — which is what lets
 * `runTurn` claim the slot BEFORE its first `await` instead of inside the
 * executor several awaits later.
 */
function createTurn(onMessage, taskOwner) {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  let notifySettled;
  const settled = new Promise((res) => {
    notifySettled = res;
  });
  return {
    onMessage,
    promise,
    resolve,
    reject,
    settled,
    notifySettled,
    aborted: false,
    abortSettleTimer: null,
    promptSent: false,
    taskOwner: taskOwner ?? null,
  };
}

function clearAbortSettleFallback(turn) {
  if (turn.abortSettleTimer) {
    clearTimeout(turn.abortSettleTimer);
    turn.abortSettleTimer = null;
  }
}

/**
 * Takes `turn` out of the slot and wakes anything waiting on its settlement.
 *
 * Used by every route that settles a turn the process was actually running. The
 * two routes that abandon a turn the process never ran — the recreate branch and
 * the reconciliation `catch` in `runTurn` — null the slot directly instead:
 * their turn is either about to run elsewhere or about to be thrown out of, so
 * announcing it as "settled" would be a lie to any future waiter.
 */
function releaseTurn(session, turn) {
  session.currentTurn = null;
  clearAbortSettleFallback(turn);
  turn.notifySettled();
}

function settleCurrentTurn(session, result) {
  const turn = session.currentTurn;
  // A turn that has only reserved the slot has no prompt in the process yet, so
  // nothing the process emits can belong to it.
  if (!turn || !turn.promptSent) {
    return false;
  }
  releaseTurn(session, turn);
  turn.resolve(result);
  return true;
}

/**
 * Arms the backstop that settles an aborted turn if the CLI acknowledged the
 * interrupt and then never terminated the turn. Mirrors `armIdleTimerIfIdle`:
 * arm-if-not-armed here, and the
 * callback re-checks at fire time that the turn it was armed for is still the
 * one in the slot rather than trusting the snapshot taken when it was armed.
 */
function armAbortSettleFallback(session, turn) {
  if (turn.abortSettleTimer) {
    return;
  }
  turn.abortSettleTimer = setTimeout(() => {
    turn.abortSettleTimer = null;
    if (session.currentTurn !== turn) {
      return;
    }
    if (settleCurrentTurn(session, { type: 'result', subtype: 'aborted' })) {
      // We just guessed that nothing more is coming for this turn, and the pool
      // cannot tell "emitted nothing" from "has not emitted yet". Record the
      // terminator we settled without — with the turn's owner, so a task its tail
      // announces is attributed to it — so that if the guess was wrong the tail is
      // swallowed rather than misattributed to whoever claims the slot next.
      session.owedTerminators.push(turn.taskOwner ?? null);
    }
    armIdleTimerIfIdle(session);
  }, ABORT_SETTLE_FALLBACK_MS);
}

/**
 * Rejects whatever turn holds the slot because the process is gone.
 *
 * A turn that has only RESERVED the slot is released without being rejected:
 * its caller is still inside `runTurn`, has not committed to this process, and
 * will fall through to creating a fresh one. Rejecting it would fail a turn
 * that is about to run correctly somewhere else.
 */
function rejectCurrentTurn(session, error) {
  const turn = session.currentTurn;
  if (!turn) {
    return;
  }
  releaseTurn(session, turn);
  if (turn.promptSent) {
    turn.reject(error);
  }
}

/**
 * Arms the idle-close timer if nothing is currently tracked as live and no
 * timer is already pending. Deliberately does NOT decide anything itself —
 * `closeIfIdle` (run only when the timer fires, `IDLE_GRACE_MS` later) is the
 * sole place that actually closes, and it re-reads `liveTaskIds` at that
 * later point rather than trusting the snapshot taken when the timer was
 * armed. That distinction matters: a caller outside the drain loop (e.g.
 * abort) can only ever see a stale/incomplete `liveTaskIds` snapshot, since a
 * message the CLI already sent may not have been routed through
 * `routeMessage` yet. Arming a deferred check — instead of closing on that
 * stale snapshot — gives any in-flight message the whole grace window to
 * arrive and register before the close decision is actually made.
 */
function armIdleTimerIfIdle(session) {
  if (session.liveTaskIds.size === 0 && !session.idleTimer) {
    session.idleTimer = setTimeout(() => closeIfIdle(session), IDLE_GRACE_MS);
  }
}

function isTaskNotification(message) {
  return message?.type === 'system' && message?.subtype === 'task_notification';
}

/**
 * The frames `trackTask` keys off. Session-scoped, not turn-scoped: they say
 * what the PROCESS is still doing, which is why they are exempt from every
 * turn-level suppression rule in `routeMessage`. Dropping one would let the pool
 * close a process with a live shell in it — the thing this pool exists to stop.
 */
function isTaskLifecycle(message) {
  return message?.type === 'system'
    && (message.subtype === 'task_started'
      || message.subtype === 'task_notification'
      || message.subtype === 'task_updated');
}

/**
 * Records which provider conversation the process is CURRENTLY on, from the
 * `session_id` the SDK stamps on its messages.
 *
 * Deliberately the most recent announcement rather than the first: a fork
 * announces the BRANCH's id on its first `system/init` and never re-announces
 * the parent's, and `claude-sdk.js`'s own capture tolerates either arrival order
 * (`shouldRecaptureSessionId`), so "first" would leave the pool believing a
 * drifted process is still on the conversation its key names — the exact bug
 * `servesADifferentConversation` exists to catch. A non-fork process announcing
 * a different id later would recreate needlessly, but that is the same
 * conclusion by a different route: the process would no longer be on the
 * conversation the key names.
 */
function trackProviderSessionId(session, message) {
  if (typeof message?.session_id === 'string' && message.session_id) {
    session.providerSessionId = message.session_id;
  }
}

function routeMessage(session, message) {
  trackProviderSessionId(session, message);
  // Captured here, not at the sinks: tracking runs first (lifecycle is exempt
  // from every suppression rule below), so by the time a sink sees the message
  // the settling task's record has already been removed.
  const settledTaskOwner = trackTask(session, message);
  const sinkMeta = { taskOwner: settledTaskOwner };

  if (session.owedTerminators.length > 0) {
    // A turn the abort fallback settled early is still unwinding inside the CLI.
    // Its tail cannot be told apart from the current turn's output — there is no
    // turn-correlation field on any SDK message — so everything up to and
    // including its terminator is swallowed, and the debt is cleared by that
    // terminator. Task lifecycle is exempt (see `isTaskLifecycle`) and still
    // reaches the session sink, which is where between-turn task events belong.
    if (isTaskLifecycle(message)) {
      session.onBetweenTurnMessage(message, sinkMeta);
      return;
    }
    if (message?.type === 'result') {
      session.owedTerminators.shift();
    }
    return;
  }

  if (message?.type === 'result') {
    settleCurrentTurn(session, message);
    closeIfIdle(session);
    return;
  }

  const turn = session.currentTurn;

  if (turn?.promptSent && !turn.aborted) {
    // A task settling while a LATER turn is in flight must still reach the
    // session sink. The in-turn path normalizes SDK messages by `message.role`
    // (claude-sessions.provider.ts), so a `system`/`task_notification` frame
    // normalizes to nothing — routing it only to the turn would make a
    // completion, a failure, or a reaper kill vanish silently, which is exactly
    // what goal 3 of the design forbids.
    if (isTaskNotification(message)) {
      session.onBetweenTurnMessage(message, sinkMeta);
    }
    turn.onMessage(message);
    return;
  }

  if (turn?.promptSent) {
    // The turn is aborted but deliberately still holds the slot until its own
    // terminator arrives. The user pressed Stop, so nothing more may appear in
    // the transcript — but a background task's settlement still has to get
    // through, so this routes exactly like the between-turn path (whose sink
    // forwards only `task_notification`).
    session.onBetweenTurnMessage(message, sinkMeta);
    return;
  }

  // No turn in flight: this is the path that carries a background task's
  // completion to the UI after its turn already finished.
  session.onBetweenTurnMessage(message, sinkMeta);

  armIdleTimerIfIdle(session);
}

/**
 * Says out loud that the process died and takes its tracked tasks down with it.
 *
 * This used to be entirely silent, which recreated the bug this pool exists to
 * fix through a new mechanism: between turns `currentTurn` is `null`, so the only
 * thing `drain`'s error path did — reject the turn — dropped the error on the
 * floor. No log line for the operator, and no frame for the user, who had been
 * told they would be notified when the task completed and so waited forever.
 *
 * A `skipTranscript` task is counted in the log but not reported: it is ambient
 * housekeeping ccui deliberately keeps out of the conversation (the same rule
 * `forwardBetweenTurnMessage` applies to its notifications), and surfacing it
 * only on the failure path would put a row the user never asked for — and cannot
 * act on — into the transcript.
 */
function reportLostTasks(session, error) {
  const lost = [...session.liveTaskIds.entries()];

  console.error('[ClaudeSessionPool] the Claude CLI process ended unexpectedly; any background task it was still running is lost', {
    appSessionId: session.appSessionId,
    lostTaskCount: lost.length,
    // Logged unconditionally, including with zero tasks and with a turn in
    // flight: the turn's own rejection tells one caller, and nothing at all
    // tells the operator that a ~320 MB subprocess just disappeared.
    error: error ? error.message : 'the message stream ended without an error',
  });

  for (const [taskId, task] of lost) {
    if (task.skipTranscript) {
      continue;
    }
    try {
      session.onTaskLost?.({ taskId, description: task.description }, { taskOwner: task.owner });
    } catch (reportError) {
      // One sink throwing must not cost the remaining tasks their report. The
      // caller's callback reaches a websocket fan-out, so it can fail for
      // reasons that have nothing to do with the next task in this list.
      console.error('[ClaudeSessionPool] failed to report a lost background task', {
        appSessionId: session.appSessionId,
        taskId,
        error: reportError instanceof Error ? reportError.message : String(reportError),
      });
    }
  }
}

async function drain(session) {
  /** The throw that ended the stream, if it ended by throwing. */
  let streamError = null;
  try {
    for await (const message of session.query) {
      routeMessage(session, message);
    }
  } catch (error) {
    streamError = error instanceof Error ? error : new Error(String(error));
    rejectCurrentTurn(session, streamError);
  } finally {
    // `destroy()` sets `dead` before the generator unwinds, so a flag still
    // false here means the process ended on its OWN — crash, OOM kill, killed
    // out of band — rather than because we closed it. Only that is a loss:
    // `closeAllSessions` (shutdown) and the recreate branch both close on
    // purpose, with nothing left to notify in the first case and nothing lost in
    // the second.
    const unexpected = !session.dead;

    // The process is gone. Reject any turn still waiting so the caller's
    // promise settles and its own safety net can complete the run.
    rejectCurrentTurn(session, new Error('Claude session process ended before the turn completed'));
    // Same four steps `destroy` performs, in the same order — including clearing
    // the hold-check timer, because this is the path a process that died on its
    // OWN takes and it never goes through `destroy`.
    markSessionDead(session);

    // Last, deliberately: teardown correctness outranks reporting, so nothing
    // below can leave a dead session sitting in the live map. `liveTaskIds` is
    // left populated — the session is out of the map, so it is unreachable, and
    // clearing it would only hide a teardown bug from `getLiveTaskIds`.
    if (unexpected) {
      reportLostTasks(session, streamError);
    }
  }
}

function createLiveSession({ appSessionId, sdkOptions, turnContext, onBetweenTurnMessage, onTaskLost, onHoldWarning, taskOwner, createQuery }) {
  const input = createInputStream();
  const query = createQuery({ prompt: input, options: sdkOptions });

  /** @type {LiveSession} */
  const session = {
    appSessionId,
    query,
    input,
    liveTaskIds: new Map(),
    providerSessionId: null,
    currentTurn: null,
    onBetweenTurnMessage,
    onTaskLost: onTaskLost ?? null,
    onHoldWarning: onHoldWarning ?? null,
    taskOwner: taskOwner ?? null,
    optionSnapshot: creationSnapshot(sdkOptions),
    // The allowlist the CLI was SPAWNED with — the set it will auto-approve from
    // for the whole life of the process, regardless of what `optionSnapshot`
    // later says. Frozen here because `optionSnapshot.allowedTools` is rewritten
    // on every reconcile, and it is the spawn-time list that has to be countered.
    spawnAllowedTools: [...(snapshotOptions(sdkOptions).allowedTools ?? [])],
    appliedPermissions: null,
    turnContext: turnContext ?? null,
    idleTimer: null,
    holdCheckTimer: null,
    dead: false,
    owedTerminators: [],
  };

  live.set(appSessionId, session);
  void drain(session);
  return session;
}

export const claudeSessionPool = {
  /**
   * Runs one turn, reusing the session's live process when there is one.
   * Resolves with that turn's SDK `result` message.
   *
   * A reused process must never keep running turn 1's options: the SDK holds
   * the `query()` options it was constructed with, so a user who switches
   * permission mode or unchecks a tool would otherwise be silently evaluated
   * against the settings they just abandoned. Reconciliation happens before the
   * prompt is pushed — recreate when nothing is at stake, reconfigure in place
   * when background work must survive.
   */
  async runTurn({ appSessionId, userMessage, sdkOptions, turnContext, onMessage, onBetweenTurnMessage, onTaskLost, onHoldWarning, taskOwner, createQuery }) {
    let session = live.get(appSessionId);
    if (session?.dead) {
      session = undefined;
    }

    if (session?.currentTurn) {
      if (!session.currentTurn.aborted) {
        throw turnInFlightError(appSessionId);
      }
      // An aborted turn keeps the slot until its terminator arrives (bounded by
      // ABORT_SETTLE_FALLBACK_MS), so a user who presses Stop and re-sends
      // immediately lands here. Waiting is the whole point: throwing would turn
      // "keep the slot so the CLI's own terminator can settle it" into an error
      // the user sees.
      await session.currentTurn.settled;
      session = live.get(appSessionId);
      if (session?.dead) {
        session = undefined;
      }
      if (session?.currentTurn) {
        // Someone else claimed the freed slot while we waited. That is genuine
        // concurrency, not a Stop-then-resend.
        throw turnInFlightError(appSessionId);
      }
    }

    const turn = createTurn(onMessage, taskOwner);

    if (session) {
      // Claim the slot SYNCHRONOUSLY, before the first `await` below. The guard
      // above and the claim used to be separated by reconciliation's awaits, so
      // two calls for one `appSessionId` could both pass the guard and the
      // second would overwrite the first's resolve/reject — the first caller's
      // promise then never settled (its run hangs in "processing") and every
      // frame from it went to the second caller's writer. Reachable in
      // production: only the websocket path is serialised by `chatRunRegistry`,
      // the REST entry point (server/routes/agent.js) is not.
      session.currentTurn = turn;

      try {
        const nextSnapshot = snapshotOptions(sdkOptions);
        const changed = differingFields(RELEVANT_OPTION_FIELDS, session.optionSnapshot, nextSnapshot);
        // No option field can say this, because it happens inside the CLI after
        // the process was spawned: an edit-prompt fork leaves the process on the
        // BRANCH's transcript while this key still names the parent. Reusing it
        // would file the turn under the wrong conversation, which is worse than
        // running it with stale options.
        const drifted = servesADifferentConversation(session, sdkOptions);

        if ((changed.length > 0 || drifted) && session.liveTaskIds.size === 0) {
          // Nothing to protect. The pre-pool behaviour closed at turn end anyway,
          // so a clean recreate costs nothing and is the only way to honour EVERY
          // option — including the ones no control request can change.
          // Hand the slot back first: `destroy` ends the drain loop, which
          // rejects whatever turn it finds there, and this turn is about to run
          // on the replacement process instead.
          session.currentTurn = null;
          destroy(session);
          session = undefined;
        } else if (changed.length > 0 || drifted) {
          // Reached only when background work forbids the recreate. A drifted
          // conversation cannot be fixed by any control request, so this reports
          // it and runs on — the same warn-and-skip contract as an unappliable
          // option field. `queryClaudeSDK` refuses the turn before it ever gets
          // here; a caller that does not is choosing the lesser of two evils and
          // is told so.
          const unappliable = [
            ...differingFields(RECREATE_ONLY_OPTION_FIELDS, session.optionSnapshot, nextSnapshot),
            ...(drifted ? [CONVERSATION_DRIFT_REASON] : []),
          ];
          if (unappliable.length > 0) {
            console.warn('[ClaudeSessionPool] keeping the live process for its background work, so these option changes cannot take effect until it closes', {
              appSessionId,
              fields: unappliable,
            });
          }
          await applyLiveOptionChanges(session, nextSnapshot);
          // Applying a control request yields the event loop; the process can die
          // in that window. Hand the slot back as well as dropping our own
          // reference: this turn is about to run on a fresh process, and a dying
          // session that still holds it will reject it from its drain loop's
          // teardown — telling the caller "process ended before the turn
          // completed" about a turn generating normally somewhere else.
          if (session.dead) {
            if (session.currentTurn === turn) {
              session.currentTurn = null;
            }
            session = undefined;
          }
        }
      } catch (error) {
        // The turn is not going to run: release the slot we claimed, or the
        // session is wedged for every later turn.
        if (session?.currentTurn === turn) {
          session.currentTurn = null;
        }
        throw error;
      }
    }

    if (session) {
      // Keep the sink pointed at the newest caller so between-turn events reach
      // whoever is currently watching, and refresh the shared turn context IN
      // PLACE so the approval callback the SDK captured on turn 1 resolves this
      // turn's writer and this turn's allow/deny lists.
      session.onBetweenTurnMessage = onBetweenTurnMessage;
      session.onTaskLost = onTaskLost ?? null;
      session.onHoldWarning = onHoldWarning ?? null;
      // Refreshed with the sinks, and for the same reason — but it applies only
      // to tasks THIS turn starts. Tasks already tracked keep the owner recorded
      // when they started, which is what stops one user's task being reported to
      // whoever took the next turn on a shared session.
      session.taskOwner = taskOwner ?? null;
      if (session.turnContext && turnContext) {
        Object.assign(session.turnContext, turnContext);
      }
    } else {
      session = createLiveSession({ appSessionId, sdkOptions, turnContext, onBetweenTurnMessage, onTaskLost, onHoldWarning, taskOwner, createQuery });
    }

    clearIdleTimer(session);

    session.currentTurn = turn;
    turn.promptSent = true;
    session.input.push(userMessage);
    return turn.promise;
  },

  hasLiveSession(appSessionId) {
    const session = live.get(appSessionId);
    return Boolean(session && !session.dead);
  },

  /**
   * Everything about this turn that the process currently live for
   * `appSessionId` cannot honour: the `RECREATE_ONLY_OPTION_FIELDS` that differ,
   * plus `CONVERSATION_DRIFT_REASON` when the process is no longer on the
   * conversation the turn continues. Empty when there is no live process
   * (nothing to be stale against) or nothing differs.
   *
   * Read-only: it answers the question, it does not act on it. The caller
   * decides what each reason means, because that depends on the reason —
   * `runTurn` recreates for any of them when nothing is at stake, and
   * `queryClaudeSDK` refuses the turn for the subset where running anyway would
   * silently do something else. The comparisons live here because the state they
   * read does (snapshot normalization, which fields creation consumed, and the
   * announced provider id); duplicating them in the caller is how the two drift
   * apart.
   */
  pendingFreshProcessReasons(appSessionId, sdkOptions) {
    const session = live.get(appSessionId);
    if (!session || session.dead) {
      return [];
    }
    return [
      ...differingFields(RECREATE_ONLY_OPTION_FIELDS, session.optionSnapshot, snapshotOptions(sdkOptions)),
      ...(servesADifferentConversation(session, sdkOptions) ? [CONVERSATION_DRIFT_REASON] : []),
    ];
  },

  /** Ids only — `liveTaskIds` also carries each task's label, which no caller wants. */
  getLiveTaskIds(appSessionId) {
    const session = live.get(appSessionId);
    return session ? [...session.liveTaskIds.keys()] : [];
  },

  /**
   * Settles an in-flight turn WITHOUT killing the process.
   *
   * No longer on the abort path: abort interrupts and lets the CLI's own
   * terminator settle the turn (see `interruptTurn`). This remains the manual
   * escape hatch — and the mechanism `armAbortSettleFallback` reproduces — for
   * a turn whose terminator never arrives.
   *
   * Never closes synchronously — an external caller can only ever hold a
   * stale view of `liveTaskIds`, since a message the CLI already sent (e.g.
   * `task_started`) may still be in flight, unrouted by this session's drain
   * loop, at the exact moment abort settles the turn. Deciding to close from
   * outside on that stale snapshot would risk killing a background task that
   * just registered — instead this only arms the same deferred idle-close
   * check `routeMessage` uses between turns, which re-reads `liveTaskIds`
   * `IDLE_GRACE_MS` later, from inside the drain loop's own ordering, by
   * which point any in-flight message has certainly been routed.
   */
  settleTurn(appSessionId, reason) {
    const session = live.get(appSessionId);
    if (!session) {
      return false;
    }
    const settled = settleCurrentTurn(session, { type: 'result', subtype: reason });
    if (settled) {
      armIdleTimerIfIdle(session);
    }
    return settled;
  },

  /**
   * Interrupts the CURRENT turn without closing the input stream or killing
   * the process — a background shell started earlier in the session must
   * survive. The underlying SDK query object never leaves the pool; callers
   * (abort) reach it only through this method. A missing/dead session is a
   * silent no-op: there is nothing left to interrupt.
   *
   * Does NOT settle the turn. An interrupted turn terminates itself — a
   * `result` with `subtype: 'error_during_execution'` arrives within
   * milliseconds (measured: `spikes/streaming-input-mode/interrupt-result.mjs`)
   * — and `SDKResultMessage` carries no turn-correlation field, so a frame that
   * arrives after the slot has been vacated cannot be attributed back to the
   * turn it came from. Keeping the slot until that terminator arrives is the
   * only way to route it correctly; the aborted turn just stops forwarding to
   * the UI in the meantime, and `armAbortSettleFallback` bounds the wait for a
   * CLI that acks the interrupt and then emits nothing.
   */
  async interruptTurn(appSessionId) {
    const session = live.get(appSessionId);
    if (!session || session.dead) {
      return false;
    }
    const turn = session.currentTurn;
    // Read BEFORE the await, not after. A turn that has only reserved the slot
    // has no prompt in the process yet, so an interrupt cannot apply to it — and
    // by the time the control request is acknowledged, that same turn may have
    // been pushed and be running. Deciding from a post-await read would mark a
    // turn the CLI never interrupted: the user's fresh prompt would run to
    // completion with every frame suppressed, and the abort fallback would be
    // armed against a live turn, free to vacate the slot mid-emission.
    const wasInFlight = Boolean(turn?.promptSent);

    // A failed interrupt PROPAGATES on purpose. Swallowing it made the only
    // caller's own catch — the sole place that undoes its "this run was
    // aborted" bookkeeping — unreachable, so the user was shown a clean
    // "stopped" while the CLI kept generating an answer whose every frame was
    // then discarded. A rejection here lets that caller stand the run back up.
    await session.query.interrupt?.();

    // Marked only once the control request has landed: until then the stop has
    // not happened, and a run that is still the user's run must keep streaming.
    if (wasInFlight && session.currentTurn === turn) {
      turn.aborted = true;
      armAbortSettleFallback(session, turn);
    }
    return true;
  },

  closeSession(appSessionId) {
    const session = live.get(appSessionId);
    if (session) {
      destroy(session);
    }
  },

  /**
   * Closes every live session. Called on server shutdown.
   *
   * Not a leak backstop: the SDK already registers one `process.on('exit')`
   * handler that SIGTERMs every child it spawned (`V2`/`W2` in `sdk.mjs`), so an
   * abrupt exit does not orphan the ~320 MB `claude` process. What that handler
   * cannot do is give the CLI a chance to shut down cleanly — a SIGTERM'd CLI
   * never reaches the `inputClosed` branch that reaps its own background tasks,
   * so those shells are left behind for the OS to inherit. Closing the input
   * stream here is what lets each CLI reap its own children before it dies.
   * @returns {number} How many sessions were closed.
   */
  closeAllSessions() {
    const sessions = [...live.values()];
    for (const session of sessions) {
      destroy(session);
    }
    live.clear();
    return sessions.length;
  },

  _resetForTests() {
    claudeSessionPool.closeAllSessions();
  },
};
