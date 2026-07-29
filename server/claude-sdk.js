/**
 * Claude SDK Integration
 *
 * This module provides SDK-based integration with Claude using the @anthropic-ai/claude-agent-sdk.
 * It mirrors the interface of claude-cli.js but uses the SDK internally for better performance
 * and maintainability.
 *
 * Key features:
 * - Direct SDK integration without child processes
 * - Session management with abort capability
 * - Options mapping between CLI and SDK formats
 * - WebSocket message streaming
 */

import crypto from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { query } from '@anthropic-ai/claude-agent-sdk';

import { createProtocolErrorFrame, emitBackgroundTaskEvent } from '@/modules/websocket/index.js';

import { claudeSessionPool, CONVERSATION_DRIFT_REASON, TURN_IN_FLIGHT_ERROR_CODE } from './claude-session-pool.js';
import { buildClaudeUserContent, normalizeImageDescriptors } from './shared/image-attachments.js';
import { CLAUDE_FALLBACK_MODELS } from './modules/providers/list/claude/claude-models.provider.js';
import { providerModelsService } from './modules/providers/services/provider-models.service.js';
import { resolveClaudeCodeExecutablePath } from './shared/claude-cli-path.js';
import {
  createNotificationEvent,
  notifyRunFailed,
  notifyRunStopped,
  notifyUserIfEnabled
} from './services/notification-orchestrator.js';
import { sessionsService } from './modules/providers/services/sessions.service.js';
import { providerAuthService } from './modules/providers/services/provider-auth.service.js';
import { createCompleteMessage, createNormalizedMessage } from './shared/utils.js';
import { setClaudeBuiltinCommands } from './utils/claude-builtin-commands.js';

const activeSessions = new Map();
const pendingToolApprovals = new Map();
// Sessions cancelled via abort-session. The abort handler already sent the
// terminal `complete` (aborted: true) to the client, so the run loop must not
// emit a second one when its generator winds down.
const abortedSessionIds = new Set();

const TOOL_APPROVAL_TIMEOUT_MS = parseInt(process.env.CLAUDE_TOOL_APPROVAL_TIMEOUT_MS, 10) || 55000;

const TOOLS_REQUIRING_INTERACTION = new Set(['AskUserQuestion', 'ExitPlanMode']);

function resolveClaudeEffort(model, effort, modelsDefinition = CLAUDE_FALLBACK_MODELS) {
  const selectedModel = modelsDefinition?.OPTIONS?.find((option) => option.value === model) || null;
  const allowedEfforts = selectedModel?.effort?.values
    ?.map((value) => value.value) || [];
  return typeof effort === 'string' && effort !== 'default' && allowedEfforts.includes(effort)
    ? effort
    : undefined;
}

function createRequestId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
}

function waitForToolApproval(requestId, options = {}) {
  const { timeoutMs = TOOL_APPROVAL_TIMEOUT_MS, signal, onCancel, metadata } = options;

  return new Promise(resolve => {
    let settled = false;

    const finalize = (decision) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(decision);
    };

    let timeout;

    const cleanup = () => {
      pendingToolApprovals.delete(requestId);
      if (timeout) clearTimeout(timeout);
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }
    };

    // timeoutMs 0 = wait indefinitely (interactive tools)
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        onCancel?.('timeout');
        finalize(null);
      }, timeoutMs);
    }

    const abortHandler = () => {
      onCancel?.('cancelled');
      finalize({ cancelled: true });
    };

    if (signal) {
      if (signal.aborted) {
        onCancel?.('cancelled');
        finalize({ cancelled: true });
        return;
      }
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    const resolver = (decision) => {
      finalize(decision);
    };
    // Attach metadata for getPendingApprovalsForSession lookup
    if (metadata) {
      Object.assign(resolver, metadata);
    }
    pendingToolApprovals.set(requestId, resolver);
  });
}

function resolveToolApproval(requestId, decision) {
  const resolver = pendingToolApprovals.get(requestId);
  if (resolver) {
    resolver(decision);
  }
}

// Match stored permission entries against a tool + input combo.
// This only supports exact tool names and the Bash(command:*) shorthand
// used by the UI; it intentionally does not implement full glob semantics,
// introduced to stay consistent with the UI's "Allow rule" format.
function matchesToolPermission(entry, toolName, input) {
  if (!entry || !toolName) {
    return false;
  }

  if (entry === toolName) {
    return true;
  }

  const bashMatch = entry.match(/^Bash\((.+):\*\)$/);
  if (toolName === 'Bash' && bashMatch) {
    const allowedPrefix = bashMatch[1];
    let command = '';

    if (typeof input === 'string') {
      command = input.trim();
    } else if (input && typeof input === 'object' && typeof input.command === 'string') {
      command = input.command.trim();
    }

    if (!command) {
      return false;
    }

    return command.startsWith(allowedPrefix);
  }

  return false;
}

function mapCliOptionsToSDK(options = {}) {
  const { sessionId, cwd, toolsSettings, permissionMode, effort, forkSubagent } = options;

  const sdkOptions = {};

  // Forward all host env vars (e.g. ANTHROPIC_BASE_URL) to the subprocess.
  // Since SDK 0.2.113, options.env replaces process.env instead of overlaying it.
  sdkOptions.env = { ...process.env };

  // FORWARD_SUBAGENT_TEXT makes the CLI emit subagent text/thinking blocks so
  // the transcript panel can show them. Harmless and always on.
  sdkOptions.env.CLAUDE_CODE_FORWARD_SUBAGENT_TEXT = '1';

  // FORK_SUBAGENT lets Claude request subagent_type "fork" (inherited-context
  // subagent, the /subtask mechanism), but it forces EVERY subagent launched
  // during the run into the background (docs, and measured). Backgrounded
  // subagents return an "Async agent launched successfully..." launch stub as
  // their whole Agent tool_result — one block, no answer, and no later
  // tool_result arrives to replace it (measured: none within 40s). That is why
  // this flag must NOT be set session-wide: it would strip the inline answer
  // from every ordinary subagent's Result box.
  //
  // CLAUDE_CODE_DISABLE_BACKGROUND_TASKS takes precedence over fork mode and
  // restores foreground subagents — so the answer comes back as a second
  // tool_result with the usual [answer, metadata] pair (precedence rule stated
  // in the docs and confirmed by measurement). But it also disables Bash
  // run_in_background entirely, so it must stay scoped to /subtask runs only,
  // never global.
  //
  // NOTE: an earlier version of this comment also claimed background subagents
  // "lose the canUseTool approval channel" and fail with "AbortError: Stream
  // closed". That clause is unverified and the docs state the opposite
  // (background subagents still surface permission prompts), so do not rely on
  // it. The two reasons above are the measured ones.
  if (forkSubagent === true) {
    sdkOptions.env.CLAUDE_CODE_FORK_SUBAGENT = '1';
    sdkOptions.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1';
  }

  // Resolve the executable eagerly on Windows because the SDK uses raw child_process.spawn,
  // which does not reliably follow npm's shell wrappers like cross-spawn does.
  sdkOptions.pathToClaudeCodeExecutable = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH);

  if (cwd) {
    sdkOptions.cwd = cwd;
  }

  if (permissionMode && permissionMode !== 'default') {
    sdkOptions.permissionMode = permissionMode;
  }

  const settings = toolsSettings || {
    allowedTools: [],
    disallowedTools: [],
    skipPermissions: false
  };

  if (settings.skipPermissions && permissionMode !== 'plan') {
    sdkOptions.permissionMode = 'bypassPermissions';
  }

  let allowedTools = [...(settings.allowedTools || [])];

  if (permissionMode === 'plan') {
    const planModeTools = ['Read', 'Task', 'exit_plan_mode', 'TodoRead', 'TodoWrite', 'WebFetch', 'WebSearch'];
    for (const tool of planModeTools) {
      if (!allowedTools.includes(tool)) {
        allowedTools.push(tool);
      }
    }
  }

  // Auto-approve subagent DISPATCH only (the act of starting a subagent),
  // so dispatch isn't silently denied — unless the user explicitly
  // disallowed the tool, in which case that opt-out wins. Tools the
  // subagent itself calls still go through the normal approval flow.
  const disallowedTools = Array.isArray(settings.disallowedTools) ? settings.disallowedTools : [];
  for (const dispatchTool of ['Agent', 'Task']) {
    if (!allowedTools.includes(dispatchTool) && !disallowedTools.includes(dispatchTool)) {
      allowedTools.push(dispatchTool);
    }
  }

  sdkOptions.allowedTools = allowedTools;

  // Use the tools preset to make all default built-in tools available (including AskUserQuestion).
  // This was introduced in SDK 0.1.57. Omitting this preserves existing behavior (all tools available),
  // but being explicit ensures forward compatibility and clarity.
  sdkOptions.tools = { type: 'preset', preset: 'claude_code' };

  sdkOptions.disallowedTools = settings.disallowedTools || [];

  sdkOptions.model = options.model || CLAUDE_FALLBACK_MODELS.DEFAULT;

  const resolvedEffort = resolveClaudeEffort(
    sdkOptions.model,
    effort,
    options.effortModels || CLAUDE_FALLBACK_MODELS,
  );
  if (resolvedEffort) {
    sdkOptions.effort = resolvedEffort;
  }

  sdkOptions.systemPrompt = {
    type: 'preset',
    preset: 'claude_code'
  };

  sdkOptions.settingSources = ['project', 'user', 'local'];

  // Emit SDKPartialAssistantMessage ("stream_event") messages so the UI can
  // render assistant text incrementally instead of waiting for a full turn.
  sdkOptions.includePartialMessages = true;

  if (sessionId) {
    sdkOptions.resume = sessionId;
  }

  // Branch a resumed session into a new session id instead of appending to it.
  // Used by both the /fork command (websocket interception) and edit-prompt
  // fork; the latter also pins the branch point via resumeSessionAt.
  if (options.forkSession) {
    sdkOptions.forkSession = true;
    if (options.resumeSessionAt) {
      sdkOptions.resumeSessionAt = options.resumeSessionAt;
    }
  }

  return sdkOptions;
}

/**
 * Reasons from `claudeSessionPool.pendingFreshProcessReasons` that must REFUSE
 * the turn — rather than be warned about and skipped — when a background task is
 * holding the session's CLI process open.
 *
 * `effort` is deliberately absent even though it is recreate-only too:
 * `applyFlagSettings`'s `effortLevel` has a narrower domain than the `effort`
 * option (`'low'|'medium'|'high'|'xhigh'` versus those plus `'max'` and
 * numbers), so it cannot be fully applied live either — but running a turn at
 * the previous effort is a degradation the user can live with, not a different
 * feature. The pool's warn-and-skip stays right for it. The reasons below are
 * different in kind: running the turn anyway silently performs a DIFFERENT
 * action than the one that was asked for, or files it under a different
 * conversation.
 */
const FRESH_PROCESS_REQUIRED_REASONS = new Set([
  'cwd',
  'forkSession',
  'resumeSessionAt',
  CONVERSATION_DRIFT_REASON,
]);

/**
 * Explains, in the user's terms, why this turn cannot run on the session's
 * current CLI process — or returns null when it can.
 *
 * Both conditions have to hold. Only a live process with live background work
 * is genuinely HELD: with nothing to protect the pool closes and recreates it
 * cleanly, which honours every option including these, and with no live process
 * at all there is nothing to be stale against.
 *
 * @param {string} poolSessionId - The APP-level session id the pool is keyed on.
 *   Never the provider-native id, which a fork reassigns mid-stream.
 * @param {object} options - The caller's options, pre-`mapCliOptionsToSDK`.
 * @param {object} sdkOptions - The mapped SDK options this turn would run with.
 * @returns {{ code: string, message: string } | null} The protocol-error code to
 *   refuse under and a user-facing explanation, or null to proceed.
 */
function describeHeldProcessRefusal(poolSessionId, options, sdkOptions) {
  if (!claudeSessionPool.hasLiveSession(poolSessionId)) {
    return null;
  }
  const liveTaskIds = claudeSessionPool.getLiveTaskIds(poolSessionId);
  if (liveTaskIds.length === 0) {
    return null;
  }

  const blocked = claudeSessionPool
    // `forkSubagent` is stated rather than read off `sdkOptions` for the reason
    // spelled out below and in the pool's `CALLER_STATED_OPTION_FIELDS`. Passing
    // it keeps this comparison honest even though the /subtask refusal itself is
    // decided from the raw option: without it a process spawned FOR a subtask
    // would report a spurious difference on every later turn.
    .pendingFreshProcessReasons(poolSessionId, sdkOptions, { forkSubagent: options.forkSubagent === true })
    .filter((reason) => FRESH_PROCESS_REQUIRED_REASONS.has(reason));

  const reasons = [];
  const forkBlocked = blocked.includes('forkSession') || blocked.includes('resumeSessionAt');

  // `forkSubagent` never reaches `sdkOptions` as a field — `mapCliOptionsToSDK`
  // turns it into child env, and `sdkOptions.env` is rebuilt every turn, so the
  // pool's snapshot cannot see it. Hence the raw option, and hence "requested
  // for this turn" rather than "differs": a held process cannot have been
  // spawned with the /subtask env, because that env disables background tasks
  // outright, so there would be nothing holding it.
  if (options.forkSubagent === true) {
    reasons.push(
      '/subtask needs its own Claude CLI process: it runs the subagent with this conversation\'s context '
      + 'inherited, which is set up through the process\'s environment when it starts and cannot be '
      + 'changed on a running one.',
    );
  }
  if (forkBlocked) {
    reasons.push(
      'Editing an earlier prompt needs its own Claude CLI process: it branches the conversation from that '
      + 'point instead of continuing from the end.',
    );
  }
  if (blocked.includes('cwd')) {
    reasons.push(
      'Running this turn in a different project directory needs its own Claude CLI process: the working '
      + 'directory is fixed when the process starts.',
    );
  }
  if (blocked.includes(CONVERSATION_DRIFT_REASON)) {
    reasons.push(
      'This session\'s Claude CLI process has moved on to a branch of the conversation (an earlier prompt '
      + 'was edited), so continuing THIS conversation needs its own process — otherwise this message would '
      + 'be filed under the branch instead.',
    );
  }

  if (reasons.length === 0) {
    return null;
  }

  const taskCount = liveTaskIds.length;
  return {
    // A refused edit-prompt fork is now an EXPECTED outcome, so it has to join
    // the fork flow's existing three-part error contract — restore the edited
    // text, restore the view, one message. `FORK_FAILED` is the frontend's only
    // route into it (`onForkFailed` is the sole caller of
    // `restoreEditSentPrompt`), and it also clears the pending-fork entry, which
    // is what stops `onCompleteWithoutBranch` adding a second, contentless error
    // row when the terminal `complete` below lands. The reason travels in the
    // message either way, so nothing is lost by reusing the code.
    //
    // Deliberately NOT extended to the drift reason: that turn is not a fork
    // request, and `onForkFailed` would push an unrelated parked edit back into
    // the composer.
    code: forkBlocked ? 'FORK_FAILED' : 'SESSION_BUSY_BACKGROUND_TASK',
    // Wording note: `getLiveTaskIds` deliberately counts ambient
    // `skip_transcript` housekeeping tasks too (closing the process would kill
    // those as well), and those appear nowhere in the conversation and have no
    // stop button. So this must not promise an affordance that may not exist —
    // "wait for it" always holds, "stop it" only when the user can see it.
    message: `${reasons.join(' ')} A background command from this session is still running `
      + `(${taskCount} task${taskCount === 1 ? '' : 's'}), and starting a new process means closing this `
      + 'one, which would kill it. Try again once it has finished — if it is shown in the conversation you '
      + 'can stop it there — or start a new session to work in the meantime.',
  };
}

/**
 * Determines whether a mid-stream `session_id` announcement should replace
 * the currently captured session id.
 *
 * Fork runs are the one case where the provider session id CHANGES mid-stream:
 * the resume seed is the PARENT's id, but the SDK announces the fork's own new
 * id on its first `system/init` message and never re-announces the parent id.
 * Non-fork runs must never re-capture — the first announced id is authoritative
 * for them, and resume runs intentionally keep the pre-seeded parent id.
 *
 * @param {boolean} isFork - Whether this run was started with forkSession.
 * @param {string|undefined} announcedId - `message.session_id` from the SDK stream.
 * @param {string|undefined} capturedId - The currently captured session id.
 * @returns {boolean}
 */
function shouldRecaptureSessionId(isFork, announcedId, capturedId) {
  return Boolean(isFork) && Boolean(announcedId) && announcedId !== capturedId;
}

/**
 * Re-captures a fork run's session id once `shouldRecaptureSessionId` says
 * the SDK has announced the fork's own (distinct) id mid-stream: swaps the
 * active-sessions tracking entry from the parent-seeded id to the new one,
 * relabels the writer so its outgoing events carry the new id, and lets the
 * caller announce `session_created` to the client.
 *
 * Extracted from the stream loop (and dependency-injected) purely so the
 * wiring — order of operations, `setSessionId` call, `session_created` send —
 * can be unit-tested without spinning up a real SDK query stream.
 *
 * @param {Object} deps
 * @param {string} deps.oldId - The currently captured (parent-seeded) session id.
 * @param {string} deps.newId - The newly announced fork session id.
 * @param {Object} deps.queryInstance - Opaque value re-tracked under the new id via
 *   `deps.addSession` — historically the raw SDK query instance, now (post
 *   session-pool wiring) a pool handle exposing `interrupt()`. This function
 *   never inspects it, only forwards it.
 * @param {Object} deps.ws - The websocket writer; its `setSessionId` (if present) labels its outgoing events.
 * @param {(sessionId: string, queryInstance: Object) => void} deps.removeSession -
 *   Ownership-scoped: it is handed `queryInstance` so it can decline to retire an
 *   entry that some other run has since registered under `oldId`.
 * @param {(sessionId: string, queryInstance: Object, writer?: Object) => void} deps.addSession
 * @param {() => void} deps.sendSessionCreated - Announces the new id to the client; caller controls once-only guarding.
 * @returns {string} `deps.newId`, so callers can reassign their captured-id variable in one line.
 */
function recaptureForkSession({ oldId, newId, queryInstance, ws, removeSession, addSession, sendSessionCreated }) {
  // Defensive narrowing, not a bug fix: no harmful interleaving is reachable
  // here (the two conditions it would need are mutually exclusive), but the
  // argument for that is subtle and this handle is registered under both ids, so
  // the ownership test is free — and no future reader has to reconstruct it.
  removeSession(oldId, queryInstance);
  addSession(newId, queryInstance, ws);
  setWriterSessionId(ws, newId);
  sendSessionCreated();

  return newId;
}

/**
 * Labels a websocket writer's outgoing events with the captured session id,
 * when the writer supports it. Shared by the first-capture and fork-recapture
 * paths so both stamp the writer the same way.
 * @param {Object} ws - The websocket writer.
 * @param {string} sessionId - The session id to label outgoing events with.
 */
function setWriterSessionId(ws, sessionId) {
  if (ws.setSessionId && typeof ws.setSessionId === 'function') {
    ws.setSessionId(sessionId);
  }
}

/**
 * Sends the `session_created` event announcing a (newly captured or
 * re-captured) session id to the client.
 * @param {Object} ws - The websocket writer.
 * @param {string} newSessionId - The session id to announce.
 */
function sendSessionCreatedEvent(ws, newSessionId) {
  ws.send(createNormalizedMessage({ kind: 'session_created', newSessionId, sessionId: newSessionId, provider: 'claude' }));
}

/**
 * Adds a session to the active sessions map
 * @param {string} sessionId - Session identifier (provider-native id)
 * @param {Object} queryInstance - SDK query instance, or (post pool-wiring) a
 *   handle exposing `interrupt()` for the pool-backed session
 * @param {Object} writer - WebSocket writer for reconnect support
 * @param {string|null} poolSessionId - The stable app-level id this run is keyed
 *   under in `claudeSessionPool` (never the provider-native `sessionId`, which
 *   forks change mid-stream). Recorded for diagnostics only: abort used to read
 *   it to settle the turn through the pool, and no longer does — it interrupts
 *   and lets the CLI's own terminator settle the turn.
 */
function addSession(sessionId, queryInstance, writer = null, poolSessionId = null) {
  activeSessions.set(sessionId, {
    instance: queryInstance,
    startTime: Date.now(),
    status: 'active',
    writer,
    poolSessionId
  });
}

/**
 * Removes a session from the active sessions map, but only while `instance` is
 * still the handle registered under `sessionId` — i.e. only the run that owns the
 * entry may retire it. (Replaces an unconditional `removeSession`, which every
 * call site turned out to need this test; there is deliberately no unguarded
 * remover left to reach for.)
 *
 * `activeSessions` is keyed by the PROVIDER-native id and `addSession`
 * overwrites, so a Stop-then-resend puts two runs on one key: the aborted turn
 * now keeps the pool's turn slot, so run 2 registers its own abort handle and
 * then parks inside `runTurn` while run 1 is still unwinding. An unconditional
 * delete on run 1's cleanup therefore deregistered RUN 2 — and the re-sent turn
 * became unstoppable, with `abortClaudeSDKSession` reporting "not found" while
 * the UI said stopped and the CLI ran the turn to completion.
 * @param {string} sessionId - Provider-native session identifier.
 * @param {Object} instance - The handle the calling run registered.
 */
function removeSessionIfOwnedBy(sessionId, instance) {
  if (activeSessions.get(sessionId)?.instance === instance) {
    activeSessions.delete(sessionId);
  }
}

/**
 * Gets a session from the active sessions map
 * @param {string} sessionId - Session identifier
 * @returns {Object|undefined} Session data or undefined
 */
function getSession(sessionId) {
  return activeSessions.get(sessionId);
}

/**
 * Gets all active session IDs
 * @returns {Array<string>} Array of active session IDs
 */
function getAllSessions() {
  return Array.from(activeSessions.keys());
}

/**
 * Transforms SDK messages to WebSocket format expected by frontend
 * @param {Object} sdkMessage - SDK message object
 * @returns {Object} Transformed message ready for WebSocket
 */
function transformMessage(sdkMessage) {
  // Extract parent_tool_use_id for subagent tool grouping
  if (sdkMessage.parent_tool_use_id) {
    return {
      ...sdkMessage,
      parentToolUseId: sdkMessage.parent_tool_use_id
    };
  }
  return sdkMessage;
}

function readNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Extracts token usage from SDK messages.
 * Prefers per-step `message.usage` (Claude message payload), then falls back
 * to result-level usage/modelUsage for compatibility across SDK versions.
 * @param {Object} sdkMessage - SDK stream message
 * @returns {Object|null} Token budget object or null
 */
function extractTokenBudget(sdkMessage) {
  if (!sdkMessage || typeof sdkMessage !== 'object') {
    return null;
  }

  const messageUsage = sdkMessage.message?.usage || sdkMessage.usage;
  if (messageUsage && typeof messageUsage === 'object') {
    const directInputTokens = readNumber(messageUsage.input_tokens ?? messageUsage.inputTokens);
    const cacheCreationTokens = readNumber(messageUsage.cache_creation_input_tokens ?? messageUsage.cacheCreationInputTokens ?? messageUsage.cacheCreationTokens);
    const cacheReadTokens = readNumber(messageUsage.cache_read_input_tokens ?? messageUsage.cacheReadInputTokens ?? messageUsage.cacheReadTokens);
    const cacheTokens = cacheCreationTokens + cacheReadTokens;
    const inputTokens = directInputTokens + cacheTokens;
    const outputTokens = readNumber(messageUsage.output_tokens ?? messageUsage.outputTokens);
    const totalUsed = inputTokens + outputTokens;
    const contextWindow = parseInt(process.env.CONTEXT_WINDOW, 10) || 160000;

    return {
      used: totalUsed,
      total: contextWindow,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      cacheTokens,
      breakdown: {
        input: inputTokens,
        output: outputTokens,
      },
    };
  }

  if (!sdkMessage.modelUsage || typeof sdkMessage.modelUsage !== 'object') {
    return null;
  }

  // Fallback for older SDK messages with only modelUsage
  const modelKey = Object.keys(sdkMessage.modelUsage)[0];
  const modelData = sdkMessage.modelUsage[modelKey];

  if (!modelData || typeof modelData !== 'object') {
    return null;
  }

  const inputTokens = readNumber(modelData.cumulativeInputTokens ?? modelData.inputTokens);
  const outputTokens = readNumber(modelData.cumulativeOutputTokens ?? modelData.outputTokens);
  const totalUsed = inputTokens + outputTokens;
  const contextWindow = parseInt(process.env.CONTEXT_WINDOW, 10) || 160000;

  return {
    used: totalUsed,
    total: contextWindow,
    inputTokens,
    outputTokens,
    breakdown: {
      input: inputTokens,
      output: outputTokens,
    },
  };
}

/**
 * Builds ONE SDKUserMessage for the pool to push into the session's open input
 * stream. Previously this returned a bare string (or a generator that closed
 * after one yield), which told the CLI input was finished and made it reap the
 * session's background shells.
 *
 * @param {string} command - User prompt
 * @param {Array} images - Image descriptors ({ path, name?, mimeType? })
 * @param {string} cwd - Project working directory image paths resolve against
 * @returns {Promise<Object>} A single SDKUserMessage
 */
async function buildPromptPayload(command, images, cwd) {
  const content = normalizeImageDescriptors(images).length === 0
    ? command
    : await buildClaudeUserContent(command, images, cwd);

  return {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Loads MCP server configurations from ~/.claude.json
 * @param {string} cwd - Current working directory for project-specific configs
 * @returns {Object|null} MCP servers object or null if none found
 */
async function loadMcpConfig(cwd) {
  try {
    const claudeConfigPath = path.join(os.homedir(), '.claude.json');

    // Check if config file exists
    try {
      await fs.access(claudeConfigPath);
    } catch (error) {
      // File doesn't exist, return null
      // No config file
      return null;
    }

    // Read and parse config file
    let claudeConfig;
    try {
      const configContent = await fs.readFile(claudeConfigPath, 'utf8');
      claudeConfig = JSON.parse(configContent);
    } catch (error) {
      console.error('Failed to parse ~/.claude.json:', error.message);
      return null;
    }

    // Extract MCP servers (merge global and project-specific)
    let mcpServers = {};

    // Add global MCP servers
    if (claudeConfig.mcpServers && typeof claudeConfig.mcpServers === 'object') {
      mcpServers = { ...claudeConfig.mcpServers };
      // Global MCP servers loaded
    }

    // Add/override with project-specific MCP servers
    if (claudeConfig.claudeProjects && cwd) {
      const projectConfig = claudeConfig.claudeProjects[cwd];
      if (projectConfig && projectConfig.mcpServers && typeof projectConfig.mcpServers === 'object') {
        mcpServers = { ...mcpServers, ...projectConfig.mcpServers };
        // Project MCP servers merged
      }
    }

    // Return null if no servers found
    if (Object.keys(mcpServers).length === 0) {
      return null;
    }
    return mcpServers;
  } catch (error) {
    console.error('Error loading MCP config:', error.message);
    return null;
  }
}

/**
 * Executes a Claude query using the SDK
 * @param {string} command - User prompt/command
 * @param {Object} options - Query options
 * @param {Object} ws - WebSocket connection
 * @returns {Promise<void>}
 */
async function queryClaudeSDK(command, options = {}, ws) {
  const { sessionId, sessionSummary } = options;
  let capturedSessionId = sessionId;
  let sessionCreatedSent = false;

  // The pool must be keyed on a STABLE app-level id, never the provider-native
  // id captured above (`capturedSessionId`/`sessionId`) — forks re-announce a
  // NEW provider id mid-stream (see `recaptureForkSession`), and a brand-new
  // session has no provider id at all until the first SDK message arrives, so
  // neither can serve as the key `runTurn` needs up front.
  //
  // `options.appSessionId` is populated by the chat websocket gateway
  // (chat-websocket.service.ts) from its own persistent session row id, which
  // never changes for the session's lifetime. The gateway is the only caller
  // that has such an id; the direct REST entry points
  // (server/routes/agent.js, server/routes/git.js) are one-shot calls with no
  // app-session concept, so they fall back to the provider-native id when
  // resuming (stable across their own repeat calls) or, for a brand-new
  // one-shot run, a fresh id scoped to just this call.
  const poolSessionId = options.appSessionId || sessionId || createRequestId();

  // What `background_task` frames may be addressed to, which is NOT
  // `poolSessionId`: those two fall-backs above are a provider-native id and a
  // one-shot request id, and the frontend takes the frame's `sessionId` as an app
  // session id and writes a transcript row into that store bucket. Null for the
  // REST entry points, which `emitBackgroundTaskEvent` then drops.
  const backgroundTaskSessionId = typeof options.appSessionId === 'string' && options.appSessionId
    ? options.appSessionId
    : null;

  // Who a background task belongs to. There is no session owner to look up (the
  // `sessions` table has no such column and the app has no session ACL), so the
  // only available notion is the user whose turn set the work going — carried by
  // the run writer.
  //
  // Handed to the pool as THIS turn's `taskOwner`: the pool stamps it on each task
  // this turn starts and hands it back with every later report about that task.
  // The reports below therefore read the owner off the task, never off this
  // binding — a background shell outlives turns, and the next turn on a shared
  // session can be someone else's, so "the current turn's user" would address the
  // wrong single person instead of everyone.
  const turnOwnerUserId = ws?.userId ?? null;

  // A stand-in for the raw SDK query instance: the pool owns the real object
  // internally (it may not even exist yet, or may be a currently-idle
  // between-turn session), so abort addresses it through the pool by
  // `poolSessionId` instead of holding a direct reference.
  const poolSessionHandle = {
    interrupt: () => claudeSessionPool.interruptTurn(poolSessionId),
  };

  // Threads `poolSessionId` through the existing `addSession` bookkeeping
  // (keyed by provider-native id) without changing `recaptureForkSession`'s
  // own signature/tests, which only know about a 3-arg `addSession` callback.
  const addSessionForPool = (id, instance, writer) => addSession(id, instance, writer, poolSessionId);

  // Everything a callback the SDK CAPTURES must resolve at call time rather than
  // at construction time.
  //
  // A live process keeps the `canUseTool` / hook functions it was constructed
  // with, so on turn 2+ of a reused session the SDK still calls TURN 1's
  // closures. Reading the writer and the permission lists off this object —
  // which the pool refreshes in place on every turn (see `runTurn`) — is what
  // makes those stale closures behave like current ones: frames go to the turn
  // that is actually running, and approvals are decided against the settings
  // the user has right now, not the ones they had when the process spawned.
  const turnContext = {
    ws,
    sessionSummary,
    getSessionId: () => capturedSessionId || sessionId || null,
    permissionMode: 'default',
    allowedTools: [],
    disallowedTools: [],
  };

  const emitNotification = (event) => {
    notifyUserIfEnabled({
      userId: turnContext.ws?.userId || null,
      writer: turnContext.ws,
      event
    });
  };

  try {
    const resolvedModel = await providerModelsService.resolveResumeModel(
      'claude',
      sessionId,
      options.model,
    );
    let effortModels = CLAUDE_FALLBACK_MODELS;
    try {
      effortModels = (await providerModelsService.getProviderModels('claude')).models;
    } catch (error) {
      console.warn('[Claude SDK] Unable to load provider models for effort validation:', error);
    }

    const sdkOptions = mapCliOptionsToSDK({
      ...options,
      model: resolvedModel || options.model,
      effortModels,
    });

    // Refuse before anything else touches the session. Some things a turn can
    // ask for are only deliverable by a FRESH process, and when background work
    // is holding this session's process open the pool cannot give it one — it
    // used to log a warning and run the turn anyway, which quietly performed a
    // different action than the one requested (a /subtask that never inherited
    // the conversation; an edited prompt appended to the tip instead of
    // branching). Refusing here, rather than in the websocket gateway, is what
    // also covers the REST entry point (server/routes/agent.js), which is not
    // registered in `chatRunRegistry` and would otherwise keep degrading
    // silently.
    //
    // Read before the awaits below, so a `task_started` routed in that window
    // reaches the pool after this decision: the turn then takes `runTurn`'s
    // warn-and-reuse branch with no refusal. Left as a race on purpose — it fails
    // toward the behaviour that shipped before this check existed, and a lock
    // spanning MCP-config and prompt-payload I/O would cost every turn to close a
    // window that only opens when a task starts in the same few milliseconds.
    const refusal = describeHeldProcessRefusal(poolSessionId, options, sdkOptions);
    if (refusal) {
      const refusalSessionId = capturedSessionId || sessionId || null;
      ws.send(createProtocolErrorFrame(refusal.code, refusal.message, refusalSessionId));
      // The websocket layer registers the run BEFORE calling this function, so a
      // return without a terminal `complete` leaves the client in "processing"
      // forever. Non-zero exit: the turn the user asked for did not happen.
      ws.send(createCompleteMessage({ provider: 'claude', sessionId: refusalSessionId, exitCode: 1 }));
      return;
    }

    const mcpServers = await loadMcpConfig(options.cwd);
    if (mcpServers) {
      sdkOptions.mcpServers = mcpServers;
    }

    // Publish this turn's permission view onto the shared context. The pool
    // copies it over the live session's context, so a captured `canUseTool`
    // reads these values and not the ones it closed over.
    turnContext.permissionMode = sdkOptions.permissionMode || 'default';
    turnContext.allowedTools = [...(sdkOptions.allowedTools || [])];
    turnContext.disallowedTools = [...(sdkOptions.disallowedTools || [])];

    sdkOptions.hooks = {
      Notification: [{
        matcher: '',
        hooks: [async (input) => {
          const message = typeof input?.message === 'string' ? input.message : 'Claude requires your attention.';
          const sid = turnContext.getSessionId();
          emitNotification(createNotificationEvent({
            provider: 'claude',
            sessionId: sid,
            kind: 'action_required',
            code: 'agent.notification',
            meta: { message, sessionName: turnContext.sessionSummary },
            severity: 'warning',
            requiresUserAction: true,
            dedupeKey: `claude:hook:notification:${sid || 'none'}:${message}`
          }));
          return {};
        }]
      }]
    };

    // Caveat: in 'auto' and 'bypassPermissions' modes the SDK resolves approval
    // at the permission-mode step and skips this callback, so interactive tools
    // (AskUserQuestion, ExitPlanMode) won't reach the UI — the classifier/bypass
    // auto-approves them and the model acts on a generated answer. Move these
    // tools to a PreToolUse hook (runs before the mode check) if we need them
    // to work in those modes.
    //
    // Every read below goes through `turnContext`, never through `sdkOptions`
    // or the enclosing `ws`/`capturedSessionId` bindings: on a reused live
    // process this function IS turn 1's closure, and those bindings describe a
    // run that has already completed.
    sdkOptions.canUseTool = async (toolName, input, context) => {
      const requiresInteraction = TOOLS_REQUIRING_INTERACTION.has(toolName);
      const activeWs = turnContext.ws;
      const sid = turnContext.getSessionId();

      if (!requiresInteraction) {
        if (turnContext.permissionMode === 'bypassPermissions') {
          return { behavior: 'allow', updatedInput: input };
        }

        const isDisallowed = (turnContext.disallowedTools || []).some(entry =>
          matchesToolPermission(entry, toolName, input)
        );
        if (isDisallowed) {
          return { behavior: 'deny', message: 'Tool disallowed by settings' };
        }

        const isAllowed = (turnContext.allowedTools || []).some(entry =>
          matchesToolPermission(entry, toolName, input)
        );
        if (isAllowed) {
          return { behavior: 'allow', updatedInput: input };
        }
      }

      const requestId = createRequestId();
      activeWs.send(createNormalizedMessage({ kind: 'permission_request', requestId, toolName, input, sessionId: sid, provider: 'claude' }));
      emitNotification(createNotificationEvent({
        provider: 'claude',
        sessionId: sid,
        kind: 'action_required',
        code: 'permission.required',
        meta: { toolName, sessionName: turnContext.sessionSummary },
        severity: 'warning',
        requiresUserAction: true,
        dedupeKey: `claude:permission:${sid || 'none'}:${requestId}`
      }));

      const decision = await waitForToolApproval(requestId, {
        timeoutMs: requiresInteraction ? 0 : undefined,
        signal: context?.signal,
        metadata: {
          _sessionId: sid,
          _toolName: toolName,
          _input: input,
          _receivedAt: new Date(),
        },
        onCancel: (reason) => {
          turnContext.ws.send(createNormalizedMessage({ kind: 'permission_cancelled', requestId, reason, sessionId: turnContext.getSessionId(), provider: 'claude' }));
        }
      });
      if (!decision) {
        return { behavior: 'deny', message: 'Permission request timed out' };
      }

      if (decision.cancelled) {
        return { behavior: 'deny', message: 'Permission request cancelled' };
      }

      if (decision.allow) {
        if (decision.rememberEntry && typeof decision.rememberEntry === 'string') {
          // Remembered for the rest of THIS turn, on the same object the next
          // turn overwrites — matching the pre-pool lifetime, where the entry
          // died with the per-turn process and the client re-sent its settings.
          if (!turnContext.allowedTools.includes(decision.rememberEntry)) {
            turnContext.allowedTools.push(decision.rememberEntry);
          }
          if (Array.isArray(turnContext.disallowedTools)) {
            turnContext.disallowedTools = turnContext.disallowedTools.filter(entry => entry !== decision.rememberEntry);
          }
        }
        return { behavior: 'allow', updatedInput: decision.updatedInput ?? input };
      }

      return { behavior: 'deny', message: decision.message ?? 'User denied tool use' };
    };

    // Older/newer SDK versions may not accept the hook shape query() is given
    // below. Falls back to a hooks-less query so the run still works —
    // notifications degrade to runtime events instead of failing the run.
    const createQueryWithHookFallback = (params) => {
      try {
        return query(params);
      } catch (hookError) {
        console.warn('Failed to initialize Claude query with hooks, retrying without hooks:', hookError?.message || hookError);
        const { hooks: _dropped, ...optionsWithoutHooks } = params.options;
        return query({ ...params, options: optionsWithoutHooks });
      }
    };

    // NOTE on CLAUDE_CODE_STREAM_CLOSE_TIMEOUT: an earlier revision set this
    // around the `query()` construction call to lengthen the stream-close
    // window. It was doing nothing. The name occurs 0 times anywhere in SDK
    // 0.3.165's `sdk.mjs` and 0 times in the CLI 2.1.220 binary — only in a
    // stale doc comment at `sdk.d.ts:474`. And even if some build did
    // read it, it could not have reached the child: `initialize()` snapshots the
    // environment (`env: c = { ...process.env }`) before our window opens, so a
    // mutation of `process.env` made later is invisible to the spawned CLI. If a
    // future SDK/CLI genuinely needs it, set it inside `sdkOptions.env` (which
    // IS forwarded to the child), never on `process.env`.

    // Track the pool handle for abort capability. For fork runs,
    // capturedSessionId is still the PARENT's id here (pre-seeded) until the
    // first init message triggers recaptureForkSession — so this briefly
    // registers the pool handle under the parent's id. Tolerated because the
    // parent can't have a concurrent run: the /fork flow guards on isProcessing.
    if (capturedSessionId) {
      addSessionForPool(capturedSessionId, poolSessionHandle, ws);
    }

    // The entire former body of `for await (const message of queryInstance)`
    // lives on unchanged here as a callback the pool drives per message —
    // moved, not rewritten, so session-id capture/recapture, builtin-command
    // caching, normalization, and ws.send all behave exactly as before.
    const handleSdkMessage = (message) => {
      // Capture session ID from first message. Any other message (session_id
      // already captured, or not a recapture candidate per
      // shouldRecaptureSessionId) needs no handling here — fall through.
      if (message.session_id && !capturedSessionId) {

        capturedSessionId = message.session_id;
        addSessionForPool(capturedSessionId, poolSessionHandle, ws);
        setWriterSessionId(ws, capturedSessionId);

        // Send session-created event only once for new sessions
        if (!sessionId && !sessionCreatedSent) {
          sessionCreatedSent = true;
          sendSessionCreatedEvent(ws, capturedSessionId);
        }
      } else if (shouldRecaptureSessionId(sdkOptions.forkSession, message.session_id, capturedSessionId)) {
        // Fork runs are pre-seeded with the PARENT's session id (resume target),
        // but the SDK announces the fork's own new id on its first system/init
        // message. Treat that announced id as authoritative so the app session
        // row gets mapped onto the fork's transcript instead of staying a ghost.
        const newSessionId = message.session_id;
        capturedSessionId = recaptureForkSession({
          oldId: capturedSessionId,
          newId: newSessionId,
          queryInstance: poolSessionHandle,
          ws,
          removeSession: removeSessionIfOwnedBy,
          addSession: addSessionForPool,
          sendSessionCreated: () => {
            if (!sessionCreatedSent) {
              sessionCreatedSent = true;
              sendSessionCreatedEvent(ws, newSessionId);
            }
          },
        });
      }

      // The init message enumerates the CLI's dispatchable built-in commands.
      // Cache them process-wide so /api/commands/list can group them for the
      // palette — sourced live from the running binary, never hardcoded.
      if (message.type === 'system' && message.subtype === 'init') {
        setClaudeBuiltinCommands(message.slash_commands);
      }

      // Transform and normalize message via adapter
      const transformedMessage = transformMessage(message);
      const sid = capturedSessionId || sessionId || null;

      // Use adapter to normalize SDK events into NormalizedMessage[]
      const normalized = sessionsService.normalizeMessage('claude', transformedMessage, sid);
      for (const msg of normalized) {
        // Preserve parentToolUseId from SDK wrapper for subagent tool grouping
        if (transformedMessage.parentToolUseId && !msg.parentToolUseId) {
          msg.parentToolUseId = transformedMessage.parentToolUseId;
        }
        ws.send(msg);
      }

      // Extract and send token budget updates from assistant/result usage payloads
      const tokenBudgetData = extractTokenBudget(message);
      if (tokenBudgetData) {
        ws.send(createNormalizedMessage({ kind: 'status', text: 'token_budget', tokenBudget: tokenBudgetData, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
      }
    };

    // Carries a background task's settlement to the UI. Reached whenever a
    // `task_notification` arrives — with no turn in flight (the task outlived
    // the turn that started it) and also from inside a later turn, where the
    // frame would otherwise be dropped by the role-keyed normalizer.
    const forwardBetweenTurnMessage = (message, meta) => {
      if (message?.type !== 'system' || message.subtype !== 'task_notification') {
        return;
      }
      // `skip_transcript` marks ambient housekeeping tasks. The pool still
      // TRACKS them (closing the process would kill them too), but they are
      // deliberately excluded from the transcript — surfacing them would put
      // rows the user never asked for into the conversation.
      if (message.skip_transcript === true) {
        return;
      }
      emitBackgroundTaskEvent({
        // The app-level id, not `capturedSessionId` — the frontend (and this
        // event's own consumer contract) never sees the provider-native id.
        sessionId: backgroundTaskSessionId,
        taskId: message.task_id,
        status: message.status,
        outputFile: message.output_file,
        summary: message.summary,
        // The owner recorded when this task STARTED, which the pool hands back
        // here — not `turnOwnerUserId`, which is whoever is running now.
        ownerUserId: meta?.taskOwner ?? null,
      });
    };

    // Reached when the pooled CLI process dies with background work still
    // tracked. That death is otherwise unobservable between turns — the pool has
    // no turn to reject there — and the user has already been told they will be
    // notified when the task completes, so silence means waiting forever.
    const reportLostBackgroundTask = ({ taskId, description }, meta) => {
      emitBackgroundTaskEvent({
        sessionId: backgroundTaskSessionId,
        taskId,
        ownerUserId: meta?.taskOwner ?? null,
        status: 'failed',
        // No `outputFile` on purpose: `task_started` carries none (measured —
        // `spikes/streaming-input-mode/task-classification.mjs`), and a task that
        // died with its process never wrote one. Sending an empty string would
        // point the user at a file that does not exist.
        summary: `${description ?? 'A background task'} — the Claude CLI process ended before this task `
          + 'reported a result, so its output was never written.',
      });
    };

    // Reached when a task has held the pooled CLI process open past the pool's
    // warn threshold. Advisory only, by ruling: nothing here (or in the pool)
    // ends the hold — an eviction rule would kill the user's running work, which
    // is the bug this pool exists to fix. What was missing was any way to SEE it.
    const reportHeldBackgroundTask = ({ taskId, description, heldForMs }, meta) => {
      const minutes = Math.max(1, Math.round(heldForMs / 60000));
      emitBackgroundTaskEvent({
        sessionId: backgroundTaskSessionId,
        taskId,
        ownerUserId: meta?.taskOwner ?? null,
        // Deliberately not one of the three settled outcomes: the task has not
        // completed, failed, or been stopped.
        status: 'running',
        // No `outputFile`: a task that is still running has not written its
        // result file, and `task_started` carries no path anyway (measured —
        // `spikes/streaming-input-mode/task-classification.mjs`).
        summary: `${description ?? 'A background task'} — ${minutes} minute${minutes === 1 ? '' : 's'} so far, `
          + 'holding a Claude CLI process open for this session. Nothing will stop it automatically.',
      });
    };

    // Reached when a task's settlement was announced ONLY by a `task_updated`
    // status patch — no `task_notification` followed it within the pool's grace
    // window. `patch.status: 'killed'` is the memory-pressure reaper's own signal,
    // and until this existed such a task reached no user at all: the pool cleared
    // its tracking and `forwardBetweenTurnMessage` forwards only notifications.
    const reportSettledBackgroundTask = ({ taskId, description, status, error }, meta) => {
      const label = description ?? 'A background task';
      // `killed` is not part of the wire vocabulary — `stopped` is, and the
      // frontend already renders it as "was stopped (likely reaped under memory
      // pressure)". Mapping it to `completed` or `failed` would either claim a
      // success that did not happen or report a failure that did not.
      const wireStatus = status === 'killed' ? 'stopped' : status;
      const detail = status === 'killed'
        ? `${label} — stopped before it finished, most likely reaped to free memory.`
        : status === 'failed'
          ? `${label} — failed${error ? `: ${error}` : ''}.`
          : `${label} — finished.`;
      emitBackgroundTaskEvent({
        sessionId: backgroundTaskSessionId,
        taskId,
        ownerUserId: meta?.taskOwner ?? null,
        // An unrecognised status must not become a green tick: the frontend fails
        // toward "not a success", so passing the CLI's word straight through is
        // the safe default for a value this code does not know.
        status: wireStatus,
        // No `outputFile`: `task_updated.patch` carries no path (only
        // `task_notification` does), and inventing one would point the user at a
        // file that may not exist.
        summary: `${detail} The Claude CLI reported no result notification for it, so its output could `
          + 'not be located.',
      });
    };

    const turnResult = await claudeSessionPool.runTurn({
      appSessionId: poolSessionId,
      userMessage: await buildPromptPayload(command, options.images, options.cwd),
      sdkOptions,
      // Stated separately because it is not an `sdkOptions` field at all:
      // `mapCliOptionsToSDK` turns it into child env, which the pool cannot
      // compare (see `CALLER_STATED_OPTION_FIELDS`). Without this the pool could
      // not see a /subtask arriving on a live process and reused it, so
      // `CLAUDE_CODE_FORK_SUBAGENT` never reached the CLI.
      forkSubagent: options.forkSubagent === true,
      turnContext,
      onMessage: handleSdkMessage,
      onBetweenTurnMessage: forwardBetweenTurnMessage,
      onTaskLost: reportLostBackgroundTask,
      onHoldWarning: reportHeldBackgroundTask,
      onTaskSettledWithoutNotification: reportSettledBackgroundTask,
      taskOwner: turnOwnerUserId,
      createQuery: createQueryWithHookFallback,
    });

    // The pool intercepts `result` messages entirely (they end a turn and
    // never reach `handleSdkMessage`) — but a SDKResultMessage still carries
    // the turn's final `modelUsage`, which the old per-turn loop forwarded as
    // a token_budget status update. Replicate that here so the token/context
    // indicator does not go stale on every turn.
    const resultTokenBudget = extractTokenBudget(turnResult);
    if (resultTokenBudget) {
      ws.send(createNormalizedMessage({ kind: 'status', text: 'token_budget', tokenBudget: resultTokenBudget, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
    }

    // Clean up session on completion — but only OUR entry. A Stop-then-resend
    // has already put the next run's handle on this same provider-native key by
    // the time we get here; deleting it would leave that run unstoppable.
    if (capturedSessionId) {
      removeSessionIfOwnedBy(capturedSessionId, poolSessionHandle);
    }

    // Send the terminal completion event — skipped for aborted runs, whose
    // terminal `complete` (aborted: true) was already sent by abort-session.
    const wasAborted = capturedSessionId ? abortedSessionIds.delete(capturedSessionId) : false;
    if (!wasAborted) {
      ws.send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 0 }));
    }
    notifyRunStopped({
      userId: ws?.userId || null,
      provider: 'claude',
      sessionId: capturedSessionId || sessionId || null,
      sessionName: sessionSummary,
      stopReason: wasAborted ? 'aborted' : 'completed'
    });
    // Complete

  } catch (error) {
    console.error('SDK query error:', error);

    // Clean up session on error — same ownership test as the completion path:
    // a later run may already hold this key.
    if (capturedSessionId) {
      removeSessionIfOwnedBy(capturedSessionId, poolSessionHandle);
    }

    const wasAborted = capturedSessionId ? abortedSessionIds.delete(capturedSessionId) : false;
    if (wasAborted) {
      // The abort already produced the terminal complete; a generator throw
      // caused by interrupt() is expected noise, not a user-facing error.
      return;
    }

    // A genuine concurrency clash — another request is already running a turn on
    // this session (the pool narrowed this to that case: a Stop-then-resend now
    // WAITS for its predecessor instead of throwing). Reported exactly like
    // `describeHeldProcessRefusal` above, and for the same reason: it is a
    // refusal, not a failure — nothing was started, nothing is broken, and the
    // pool's internal sentence (`Session "<id>" already has a turn in flight`)
    // is not something to show a user. Reusing that shape rather than inventing a
    // second one also keeps the frontend at one contract: `protocol_error` stops
    // the spinner and writes one error row, then the terminal `complete` settles
    // the run the websocket layer had already registered.
    //
    // Deliberately BEFORE the installed-CLI probe below: whether the binary is on
    // PATH has nothing to do with this outcome, and that branch would happily
    // tell a user with a working CLI that Claude Code is not installed. No
    // `notifyRunFailed` either — same as the held-process refusal, and "run
    // failed" would misdescribe a turn that never began.
    if (error?.code === TURN_IN_FLIGHT_ERROR_CODE) {
      const clashSessionId = capturedSessionId || sessionId || null;
      ws.send(createProtocolErrorFrame(
        TURN_IN_FLIGHT_ERROR_CODE,
        'Another request is already running on this session, so this message was not started. '
        + 'Wait for it to finish — or stop it — and send again.',
        clashSessionId,
      ));
      ws.send(createCompleteMessage({ provider: 'claude', sessionId: clashSessionId, exitCode: 1 }));
      return;
    }

    // Check if Claude CLI is installed for a clearer error message
    const installed = await providerAuthService.isProviderInstalled('claude');
    const errorContent = !installed
      ? 'Claude Code is not installed. Please install it first: https://docs.anthropic.com/en/docs/claude-code'
      : error.message;

    // Send error to WebSocket, then the terminal complete
    ws.send(createNormalizedMessage({ kind: 'error', content: errorContent, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
    ws.send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 1 }));
    notifyRunFailed({
      userId: ws?.userId || null,
      provider: 'claude',
      sessionId: capturedSessionId || sessionId || null,
      sessionName: sessionSummary,
      error
    });
  }
}

/**
 * Aborts an active SDK session
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if session was aborted, false if not found
 */
async function abortClaudeSDKSession(sessionId) {
  const session = getSession(sessionId);

  if (!session) {
    console.log(`Session ${sessionId} not found`);
    return false;
  }

  try {
    console.log(`Aborting SDK session: ${sessionId}`);

    // Mark before interrupting so the run loop knows not to emit its own
    // terminal complete (the abort handler sends the aborted one).
    abortedSessionIds.add(sessionId);

    // Call interrupt() on the query instance (the pool's shim — it interrupts
    // the CURRENT turn and nothing else). The process stays alive on purpose,
    // because a background shell started earlier in this session must survive
    // abort. A rejection lands in the catch below, which stands the run back up.
    await session.instance.interrupt();

    // Deliberately does NOT settle the turn. An interrupted turn terminates
    // itself — a `result` with subtype `error_during_execution` arrives within
    // milliseconds (measured: `spikes/streaming-input-mode/interrupt-result.mjs`;
    // the earlier spike that concluded otherwise had interrupted with no turn
    // in flight, so there was nothing to terminate). `SDKResultMessage` carries
    // no turn-correlation field, so a frame arriving after the turn slot has
    // been vacated cannot be attributed back to the turn it came from: the pool
    // keeps the slot, stops forwarding that turn's frames to the UI, and lets
    // the real terminator settle it. `interruptTurn` arms its own timed fallback
    // in case the CLI acks the interrupt and then emits nothing, so the run
    // cannot hang in "processing" either way. (A FAILED interrupt is a
    // different path: it rejects into the catch below, never marks the turn, and
    // the run carries on to its own natural terminator.)
    //
    // Also deliberately not deciding here whether to close the pool session. A
    // `task_started` the CLI already sent (but the pool's drain loop has not
    // routed yet) is invisible to any check made from out here — `interrupt()`
    // is awaited above, which yields the event loop, so by the time this line
    // runs a message can be sitting in the query's async iterator, not yet
    // reflected in `getLiveTaskIds`. Closing on that stale read would kill a
    // background task that just started. The pool's own idle-close timer,
    // armed when the turn actually settles, runs inside the drain loop's
    // ordering and re-checks `liveTaskIds` right before acting.

    // Update session status
    session.status = 'aborted';

    // Clean up session, so a second Stop is a no-op. Ownership-scoped for the
    // same reason as the completion path: `interrupt()` is awaited above, and
    // this key is shared by every run of this provider session.
    removeSessionIfOwnedBy(sessionId, session.instance);

    return true;
  } catch (error) {
    console.error(`Error aborting session ${sessionId}:`, error);
    // The run keeps going; let it emit its own terminal complete.
    abortedSessionIds.delete(sessionId);
    return false;
  }
}

/**
 * Closes every live pooled `claude` process.
 *
 * Called from the server's shutdown handler. Not a leak backstop — the SDK
 * already SIGTERMs every child it spawned from its own `process.on('exit')`
 * handler, so the ~320 MB process does not survive us either way.
 *
 * It does NOT let each CLI reap its own background shells first, whatever an
 * earlier version of this comment said: the pool closes the input and calls
 * `query.close()` in the same tick, and that call forcefully terminates the CLI
 * subprocess (`sdk.d.ts`), with `process.exit(0)` right behind it — so the CLI
 * never gets an event-loop turn in which to notice. Those shells are orphaned to
 * the OS. See `claudeSessionPool.closeAllSessions` for what closing actually buys
 * (our own timers, reports and bookkeeping, deterministically) and why a real
 * drain window is a non-goal.
 * @returns {number} How many live sessions were closed.
 */
function shutdownClaudeSessions() {
  return claudeSessionPool.closeAllSessions();
}

/**
 * Checks if an SDK session is currently active
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if session is active
 */
function isClaudeSDKSessionActive(sessionId) {
  const session = getSession(sessionId);
  return session && session.status === 'active';
}

/**
 * Gets all active SDK session IDs
 * @returns {Array<string>} Array of active session IDs
 */
function getActiveClaudeSDKSessions() {
  return getAllSessions();
}

/**
 * Get pending tool approvals for a specific session.
 * @param {string} sessionId - The session ID
 * @returns {Array} Array of pending permission request objects
 */
function getPendingApprovalsForSession(sessionId) {
  const pending = [];
  for (const [requestId, resolver] of pendingToolApprovals.entries()) {
    if (resolver._sessionId === sessionId) {
      pending.push({
        requestId,
        toolName: resolver._toolName || 'UnknownTool',
        input: resolver._input,
        context: resolver._context,
        sessionId,
        receivedAt: resolver._receivedAt || new Date(),
      });
    }
  }
  return pending;
}

/**
 * Reconnect a session's WebSocketWriter to a new raw WebSocket.
 * Called when client reconnects (e.g. page refresh) while SDK is still running.
 * @param {string} sessionId - The session ID
 * @param {Object} newRawWs - The new raw WebSocket connection
 * @returns {boolean} True if writer was successfully reconnected
 */
function reconnectSessionWriter(sessionId, newRawWs) {
  const session = getSession(sessionId);
  if (!session?.writer?.updateWebSocket) return false;
  session.writer.updateWebSocket(newRawWs);
  console.log(`[RECONNECT] Writer swapped for session ${sessionId}`);
  return true;
}

// Export public API
export {
  queryClaudeSDK,
  abortClaudeSDKSession,
  shutdownClaudeSessions,
  isClaudeSDKSessionActive,
  getActiveClaudeSDKSessions,
  resolveToolApproval,
  getPendingApprovalsForSession,
  reconnectSessionWriter,
  mapCliOptionsToSDK,
  shouldRecaptureSessionId,
  recaptureForkSession
};
