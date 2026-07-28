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

import { emitBackgroundTaskEvent } from '@/modules/websocket/index.js';

import { claudeSessionPool } from './claude-session-pool.js';
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
  // subagent, the /subtask mechanism), but per the docs it forces EVERY
  // subagent launched during the run into the background. Background
  // subagents lose the canUseTool approval channel, so any tool needing
  // approval fails with "AbortError: Stream closed", and their results
  // surface as duplicate task-notifications plus an "Async agent launched
  // successfully..." boilerplate leaking into the Agent tool_result.
  // CLAUDE_CODE_DISABLE_BACKGROUND_TASKS takes precedence over fork mode and
  // keeps subagents foreground (docs-confirmed precedence rule) — but it also
  // disables Bash run_in_background entirely, so it must stay scoped to
  // /subtask runs only, not global.
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
 * @param {(sessionId: string) => void} deps.removeSession
 * @param {(sessionId: string, queryInstance: Object, writer?: Object) => void} deps.addSession
 * @param {() => void} deps.sendSessionCreated - Announces the new id to the client; caller controls once-only guarding.
 * @returns {string} `deps.newId`, so callers can reassign their captured-id variable in one line.
 */
function recaptureForkSession({ oldId, newId, queryInstance, ws, removeSession, addSession, sendSessionCreated }) {
  removeSession(oldId);
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
 * @param {string|null} poolSessionId - The stable app-level id this run is
 *   keyed under in `claudeSessionPool`, so abort can address the pool by the
 *   same key `queryClaudeSDK` used for `runTurn` (never the provider-native
 *   `sessionId`, which forks change mid-stream).
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
 * Removes a session from the active sessions map
 * @param {string} sessionId - Session identifier
 */
function removeSession(sessionId) {
  activeSessions.delete(sessionId);
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

  const emitNotification = (event) => {
    notifyUserIfEnabled({
      userId: ws?.userId || null,
      writer: ws,
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

    const mcpServers = await loadMcpConfig(options.cwd);
    if (mcpServers) {
      sdkOptions.mcpServers = mcpServers;
    }

    sdkOptions.hooks = {
      Notification: [{
        matcher: '',
        hooks: [async (input) => {
          const message = typeof input?.message === 'string' ? input.message : 'Claude requires your attention.';
          emitNotification(createNotificationEvent({
            provider: 'claude',
            sessionId: capturedSessionId || sessionId || null,
            kind: 'action_required',
            code: 'agent.notification',
            meta: { message, sessionName: sessionSummary },
            severity: 'warning',
            requiresUserAction: true,
            dedupeKey: `claude:hook:notification:${capturedSessionId || sessionId || 'none'}:${message}`
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
    sdkOptions.canUseTool = async (toolName, input, context) => {
      const requiresInteraction = TOOLS_REQUIRING_INTERACTION.has(toolName);

      if (!requiresInteraction) {
        if (sdkOptions.permissionMode === 'bypassPermissions') {
          return { behavior: 'allow', updatedInput: input };
        }

        const isDisallowed = (sdkOptions.disallowedTools || []).some(entry =>
          matchesToolPermission(entry, toolName, input)
        );
        if (isDisallowed) {
          return { behavior: 'deny', message: 'Tool disallowed by settings' };
        }

        const isAllowed = (sdkOptions.allowedTools || []).some(entry =>
          matchesToolPermission(entry, toolName, input)
        );
        if (isAllowed) {
          return { behavior: 'allow', updatedInput: input };
        }
      }

      const requestId = createRequestId();
      ws.send(createNormalizedMessage({ kind: 'permission_request', requestId, toolName, input, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
      emitNotification(createNotificationEvent({
        provider: 'claude',
        sessionId: capturedSessionId || sessionId || null,
        kind: 'action_required',
        code: 'permission.required',
        meta: { toolName, sessionName: sessionSummary },
        severity: 'warning',
        requiresUserAction: true,
        dedupeKey: `claude:permission:${capturedSessionId || sessionId || 'none'}:${requestId}`
      }));

      const decision = await waitForToolApproval(requestId, {
        timeoutMs: requiresInteraction ? 0 : undefined,
        signal: context?.signal,
        metadata: {
          _sessionId: capturedSessionId || sessionId || null,
          _toolName: toolName,
          _input: input,
          _receivedAt: new Date(),
        },
        onCancel: (reason) => {
          ws.send(createNormalizedMessage({ kind: 'permission_cancelled', requestId, reason, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
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
          if (!sdkOptions.allowedTools.includes(decision.rememberEntry)) {
            sdkOptions.allowedTools.push(decision.rememberEntry);
          }
          if (Array.isArray(sdkOptions.disallowedTools)) {
            sdkOptions.disallowedTools = sdkOptions.disallowedTools.filter(entry => entry !== decision.rememberEntry);
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
          removeSession,
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

    // Only background-task settlement is meaningful with no turn in flight —
    // it is the path that carries a background task's completion to the UI
    // after the turn that started it already ended.
    const forwardBetweenTurnMessage = (message) => {
      if (message?.type !== 'system' || message.subtype !== 'task_notification') {
        return;
      }
      emitBackgroundTaskEvent({
        // The app-level id, not `capturedSessionId` — the frontend (and this
        // event's own consumer contract) never sees the provider-native id.
        sessionId: poolSessionId,
        taskId: message.task_id,
        status: message.status,
        outputFile: message.output_file,
        summary: message.summary,
      });
    };

    // Query constructor reads this synchronously; kept set for the whole turn
    // because construction now happens lazily inside the pool (only when a
    // NEW process is actually spun up, not on every turn of a reused session).
    const prevStreamTimeout = process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT;
    process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = '300000';

    let turnResult;
    try {
      turnResult = await claudeSessionPool.runTurn({
        appSessionId: poolSessionId,
        userMessage: await buildPromptPayload(command, options.images, options.cwd),
        sdkOptions,
        onMessage: handleSdkMessage,
        onBetweenTurnMessage: forwardBetweenTurnMessage,
        createQuery: createQueryWithHookFallback,
      });
    } finally {
      if (prevStreamTimeout !== undefined) {
        process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = prevStreamTimeout;
      } else {
        delete process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT;
      }
    }

    // The pool intercepts `result` messages entirely (they end a turn and
    // never reach `handleSdkMessage`) — but a SDKResultMessage still carries
    // the turn's final `modelUsage`, which the old per-turn loop forwarded as
    // a token_budget status update. Replicate that here so the token/context
    // indicator does not go stale on every turn.
    const resultTokenBudget = extractTokenBudget(turnResult);
    if (resultTokenBudget) {
      ws.send(createNormalizedMessage({ kind: 'status', text: 'token_budget', tokenBudget: resultTokenBudget, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
    }

    // Clean up session on completion
    if (capturedSessionId) {
      removeSession(capturedSessionId);
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

    // Clean up session on error
    if (capturedSessionId) {
      removeSession(capturedSessionId);
    }

    const wasAborted = capturedSessionId ? abortedSessionIds.delete(capturedSessionId) : false;
    if (wasAborted) {
      // The abort already produced the terminal complete; a generator throw
      // caused by interrupt() is expected noise, not a user-facing error.
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

    // Call interrupt() on the query instance. This only interrupts the
    // CURRENT turn — the process stays alive on purpose, because a
    // background shell started earlier in this session must survive abort.
    await session.instance.interrupt();

    // An interrupted turn emits no `result` (verified in the spike), so
    // `runTurn`'s promise would never settle on its own — settle it
    // ourselves. Keyed by `poolSessionId` (the app-level id), NOT `sessionId`
    // (the provider-native id this function receives) — those are different
    // key spaces; see the `poolSessionId` derivation in `queryClaudeSDK`.
    //
    // Deliberately NOT deciding here whether to close the pool session. A
    // `task_started` the CLI already sent (but the pool's drain loop has not
    // routed yet) is invisible to any check made from out here — `interrupt()`
    // is awaited above, which yields the event loop, so by the time this line
    // runs a message can be sitting in the query's async iterator, not yet
    // reflected in `getLiveTaskIds`. Closing on that stale read would kill a
    // background task that just started — the exact bug this plan exists to
    // fix. `settleTurn` itself now arms the pool's own idle-close timer (see
    // `claude-session-pool.js`), which runs inside the drain loop's ordering
    // and re-checks `liveTaskIds` right before acting, 60s later — long
    // enough that an in-flight message has certainly been routed by then.
    if (session.poolSessionId) {
      claudeSessionPool.settleTurn(session.poolSessionId, 'aborted');
    }

    // Update session status
    session.status = 'aborted';

    // Clean up session
    removeSession(sessionId);

    return true;
  } catch (error) {
    console.error(`Error aborting session ${sessionId}:`, error);
    // The run keeps going; let it emit its own terminal complete.
    abortedSessionIds.delete(sessionId);
    return false;
  }
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
  isClaudeSDKSessionActive,
  getActiveClaudeSDKSessions,
  resolveToolApproval,
  getPendingApprovalsForSession,
  reconnectSessionWriter,
  mapCliOptionsToSDK,
  shouldRecaptureSessionId,
  recaptureForkSession
};
