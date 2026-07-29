import path from 'node:path';

import type { WebSocket } from 'ws';

import { sessionsDb } from '@/modules/database/index.js';
import { findForkResumePoint, sessionsService } from '@/modules/providers/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients, WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import { getGlobalImageAssetsDir, normalizeImageDescriptors } from '@/shared/image-attachments.js';
import type {
  AnyRecord,
  AuthenticatedWebSocketRequest,
  LLMProvider,
  RealtimeClientConnection,
} from '@/shared/types.js';
import { createNormalizedMessage, parseIncomingJsonObject } from '@/shared/utils.js';

/**
 * Trust boundary for client-supplied image attachments: chat.send options come
 * straight from the browser, and the provider runtimes read the referenced
 * files off disk (Claude base64-encodes them into the prompt). Only images
 * that live directly inside the global upload store (`~/.cloudcli/assets`,
 * where POST /api/assets/images puts them) are allowed through — anything
 * else (absolute paths elsewhere, traversal, subdirectories) is dropped.
 *
 * Exported for tests; `assetsRootOverride` exists only for them.
 */
export function filterImagesToUploadStore(images: unknown, assetsRootOverride?: string): AnyRecord[] {
  const assetsRoot = path.resolve(assetsRootOverride ?? getGlobalImageAssetsDir());

  return normalizeImageDescriptors(images).filter((descriptor) => {
    // Relative paths are anchored in the store; absolute ones must already be in it.
    const resolved = path.resolve(assetsRoot, descriptor.path);
    const relative = path.relative(assetsRoot, resolved);
    const isDirectChild =
      relative.length > 0 &&
      !relative.startsWith('..') &&
      !path.isAbsolute(relative) &&
      !relative.includes(path.sep) &&
      !relative.includes('/');

    if (!isDirectChild) {
      console.warn(`[Chat] Dropping image outside the upload store: ${descriptor.path}`);
    }
    return isDirectChild;
  });
}

/**
 * One provider runtime entry point. All five runtimes share this signature,
 * which lets the chat handler dispatch through a provider-keyed map instead
 * of provider-specific branches.
 */
type ProviderSpawnFn = (
  command: string,
  options: AnyRecord,
  writer: unknown
) => Promise<unknown>;

type ChatWebSocketDependencies = {
  /** Provider runtimes keyed by provider id. */
  spawnFns: Record<LLMProvider, ProviderSpawnFn>;
  /**
   * Abort functions keyed by provider id. They are addressed with the
   * provider-native session id (that is how runtimes key their process maps).
   * The Claude abort is async; the rest are sync — both shapes are accepted.
   */
  abortFns: Record<LLMProvider, (providerSessionId: string) => boolean | Promise<boolean>>;
  resolveToolApproval: (
    requestId: string,
    payload: {
      allow: boolean;
      updatedInput?: unknown;
      message?: string;
      rememberEntry?: unknown;
    }
  ) => void;
  /** Claude-only today: pending tool approvals included in `chat_subscribed`. */
  getPendingApprovalsForSession: (providerSessionId: string) => unknown[];
};

/**
 * Extracts the authenticated request user id in the formats currently produced
 * by platform and OSS auth code paths.
 */
function readRequestUserId(
  request: AuthenticatedWebSocketRequest | undefined
): string | number | null {
  const user = request?.user;
  if (!user) {
    return null;
  }

  if (typeof user.id === 'string' || typeof user.id === 'number') {
    return user.id;
  }

  if (typeof user.userId === 'string' || typeof user.userId === 'number') {
    return user.userId;
  }

  return null;
}

function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WS_OPEN_STATE) {
    ws.send(JSON.stringify(payload));
  }
}

/** Guarded send for pre-built (already-stringified) frames, e.g. `createNormalizedMessage` output. */
function sendIfOpen(ws: WebSocket, payload: string): void {
  if (ws.readyState === WS_OPEN_STATE) {
    ws.send(payload);
  }
}

/**
 * The protocol-error frame shape, in one place.
 *
 * Protocol errors deliberately use their own `kind` (instead of the provider
 * `error` message kind) so the frontend can distinguish "your request was
 * invalid" from "the model run produced an error" without inspecting text.
 *
 * Exported (and re-exported from the module barrel) because a provider runtime
 * can also have to refuse a request it cannot honour — `queryClaudeSDK` refuses
 * a turn that would need a fresh CLI process while a background task is holding
 * the current one. Only the SHAPE is shared, not the send: this gateway writes
 * straight to a raw `WebSocket`, whereas a runtime holds a `ChatSessionWriter`
 * that takes the frame as an object and remaps its `sessionId` to the app id.
 * Handing the writer to `sendProtocolError` would silently send nothing (a
 * writer has no `readyState`).
 */
export function createProtocolErrorFrame(
  code: string,
  error: string,
  sessionId?: string | null
): AnyRecord {
  return {
    kind: 'protocol_error',
    code,
    error,
    sessionId: sessionId ?? null,
    timestamp: new Date().toISOString(),
  };
}

/** Reports a protocol-level failure to the requesting client. */
function sendProtocolError(
  ws: WebSocket,
  code: string,
  error: string,
  sessionId?: string
): void {
  sendJson(ws, createProtocolErrorFrame(code, error, sessionId));
}

function readRequiredSessionId(data: AnyRecord): string | null {
  const sessionId = typeof data.sessionId === 'string' ? data.sessionId.trim() : '';
  return sessionId.length > 0 ? sessionId : null;
}

/** Exported for tests: shapes the fork-specific runtime options. */
export function buildForkRuntimeOptions(
  editAtMessageUuid: string | null,
  forkResumeSessionAt: string | null,
): AnyRecord {
  if (!editAtMessageUuid) return {};
  return { forkSession: true, ...(forkResumeSessionAt ? { resumeSessionAt: forkResumeSessionAt } : {}) };
}

/**
 * Exported for tests: reduces a client-sent edit anchor to the BARE transcript
 * uuid that `findForkResumePoint` matches against.
 *
 * The frontend renders normalized message PARTS whose ids suffix the bare
 * uuid (`<uuid>_text_<n>` / `<uuid>_text` / `<uuid>_tr_<toolUseId>` /
 * `<uuid>_images` / `<uuid>_<n>` — see the Claude normalizer). The frontend
 * already strips these (src/components/chat/utils/branchAnchors.ts,
 * `baseMessageUuid` — keep the two regexes in sync), but the server must not
 * trust the client's id format, so it normalizes again on receipt.
 */
export function normalizeEditAtMessageUuid(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.replace(/_(?:tr_.+|text(?:_\d+)?|images|\d+)$/, '');
}

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

/**
 * Rewrites a `/subtask <task>` payload into the explicit fork-subagent prompt
 * sent to the runtime. There is no SDK API to force this — explicit prompting
 * is the documented technique and CLAUDE_CODE_FORK_SUBAGENT=1 is always set.
 * Best-effort: the model usually complies but may act directly instead.
 */
export function buildSubtaskPrompt(task: string): string {
  return [
    `Use the Agent tool with subagent_type "fork" to work on the following task in the background`,
    `(a fork inherits this conversation's full context, so do not re-explain the situation to it).`,
    `Report its result back here when it finishes. Task:`,
    '',
    task,
  ].join('\n');
}

/**
 * Handles `chat.send`: resolves the session row (provider, project path, and
 * provider-native id all come from the database — never from the client),
 * registers the run, and dispatches to the provider runtime.
 */
async function handleChatSend(
  ws: WebSocket,
  userId: string | number | null,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): Promise<void> {
  const sessionId = readRequiredSessionId(data);
  if (!sessionId) {
    sendProtocolError(ws, 'SESSION_ID_REQUIRED', 'chat.send requires a sessionId.');
    return;
  }

  const session = sessionsDb.getSessionById(sessionId);
  if (!session) {
    sendProtocolError(
      ws,
      'SESSION_NOT_FOUND',
      `Session "${sessionId}" was not found. Create it via POST /api/providers/sessions first.`,
      sessionId
    );
    return;
  }

  const provider = session.provider as LLMProvider;
  const spawnFn = dependencies.spawnFns[provider];
  if (!spawnFn) {
    sendProtocolError(ws, 'UNSUPPORTED_PROVIDER', `Provider "${provider}" is not available.`, sessionId);
    return;
  }

  const clientOptions = (data.options ?? {}) as AnyRecord;
  // Fork options are server-derived only (buildForkRuntimeOptions / the /fork
  // block below). A client-supplied forkSession/resumeSessionAt would skip the
  // edit-prompt validation entirely and — because forkMeta stays unset — make
  // recordProviderSessionId remap THIS session's provider id onto the fork's,
  // silently orphaning the original transcript.
  delete clientOptions.forkSession;
  delete clientOptions.resumeSessionAt;
  const editAtMessageUuid = normalizeEditAtMessageUuid(clientOptions.editAtMessageUuid);

  let forkResumeSessionAt: string | null = null;
  if (editAtMessageUuid) {
    if (provider !== 'claude') {
      sendProtocolError(ws, 'FORK_FAILED', 'Editing a sent prompt is only supported for Claude sessions.', sessionId);
      return;
    }
    if (!session.provider_session_id || !session.jsonl_path) {
      sendProtocolError(ws, 'FORK_FAILED', 'This session has no transcript to fork yet.', sessionId);
      return;
    }
    try {
      const point = await findForkResumePoint(session.jsonl_path, session.provider_session_id, editAtMessageUuid);
      forkResumeSessionAt = point.resumeSessionAt;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendProtocolError(ws, 'FORK_FAILED', `Cannot fork: ${message}`, sessionId);
      return;
    }
    // No preceding assistant turn means this is the conversation's FIRST
    // prompt. Omitting resumeSessionAt would make the SDK copy the FULL
    // history into the branch (spike-verified), so the "edited" prompt would
    // just append after the old conversation — wrong semantics. The UI hides
    // the edit affordance for the first prompt; this guard covers stale or
    // non-UI clients.
    if (!forkResumeSessionAt) {
      sendProtocolError(
        ws,
        'FORK_FAILED',
        'Editing the first prompt of a conversation is not supported — start a new session instead.',
        sessionId
      );
      return;
    }
  }

  const forkCommand = provider === 'claude' ? parseForkCommand(typeof data.content === 'string' ? data.content : '') : null;
  if (forkCommand) {
    if (!session.provider_session_id) {
      sendProtocolError(ws, 'FORK_NO_HISTORY', 'Cannot fork a session that has no conversation yet.', sessionId);
      return;
    }

    if (chatRunRegistry.isProcessing(sessionId)) {
      sendProtocolError(ws, 'RUN_IN_PROGRESS', `Session "${sessionId}" already has a run in progress.`, sessionId);
      return;
    }

    let forked: ReturnType<typeof sessionsService.createAppSession>;
    let forkRun: ReturnType<typeof chatRunRegistry.startRun>;
    const forkedName = `${session.custom_name || 'Session'} (fork)`;
    const parentProviderSessionId = session.provider_session_id;
    // Resolves to whether the write-back attempted at announcement time (see
    // `onProviderSessionId` below) landed. `null` means it never got a chance
    // to run at all (e.g. the SDK never announced a distinct id before the
    // run ended) — treated the same as "failed" below, since either way the
    // post-spawn retry is the only thing that can still make it land.
    let earlyRenameWriteBack: Promise<boolean> | null = null;
    try {
      // Allocate the fork its own app session row; the SDK announces the fork's
      // provider id mid-run and the session writer maps it onto this row.
      forked = sessionsService.createAppSession('claude', session.project_path ?? '');
      sessionsDb.updateSessionCustomName(forked.sessionId, forkedName);

      forkRun = chatRunRegistry.startRun({
        appSessionId: forked.sessionId,
        provider,
        providerSessionId: session.provider_session_id,
        connection: ws,
        userId,
        // The fork's transcript is a copy of the parent's history, so the
        // sessions-watcher sync would otherwise pick up the parent's inherited
        // title event and clobber the " (fork)" suffix set above. Write the
        // fork's own name back into its transcript as a `custom-title` event
        // (highest sync precedence) as soon as the SDK announces the fork's
        // OWN provider session id (distinct from the parent's, which this run
        // was seeded with to resume) — not after the whole run finishes,
        // which could be minutes away and leaves the wrong name visible in
        // the sidebar until then. A run that ends without ever announcing a
        // distinct id (e.g. spawn fails immediately) leaves
        // `earlyRenameWriteBack` `null`; the post-spawn check below covers
        // the retry either way.
        onProviderSessionId: (announcedProviderSessionId) => {
          if (earlyRenameWriteBack || announcedProviderSessionId === parentProviderSessionId) {
            return;
          }
          earlyRenameWriteBack = sessionsService
            .renameSessionById(forked.sessionId, forkedName)
            .then((result) => result.writeBack)
            .catch((renameError) => {
              const message = renameError instanceof Error ? renameError.message : String(renameError);
              console.warn('[Chat] Failed to write back forked session name at announcement', {
                sessionId: forked.sessionId,
                error: message,
              });
              return false;
            });
        },
      });
      if (!forkRun) {
        sendProtocolError(ws, 'RUN_IN_PROGRESS', `Forked session "${forked.sessionId}" already has a run in progress.`, sessionId);
        return;
      }

      // Ack into the ORIGINAL session's transcript so the user sees where the fork went.
      sendIfOpen(ws, JSON.stringify(createNormalizedMessage({
        kind: 'task_notification',
        sessionId,
        provider,
        status: 'completed',
        summary: `Forked conversation into a new session${forkCommand.prompt ? ' and started it on the given prompt' : ''}. Find it in the sidebar as "${session.custom_name || 'Session'} (fork)".`,
      })));
    } catch (error) {
      // Setup never marked the ORIGINAL session as processing, so there is no
      // run state to clean up here beyond surfacing the failure. Report into
      // the original session's transcript (not sendProtocolError) because a
      // sessionId-less protocol error would only reach the console.
      const message = error instanceof Error ? error.message : String(error);
      console.error('[Chat] /fork setup failed', { sessionId, error: message });
      sendIfOpen(ws, JSON.stringify(createNormalizedMessage({
        kind: 'task_notification',
        sessionId,
        provider,
        status: 'failed',
        summary: `Failed to fork this conversation: ${message}`,
      })));
      return;
    }

    const forkOptions: AnyRecord = {
      ...clientOptions,
      // Resume-only run: attachments belong to the original message, not this fork.
      images: [],
      sessionId: session.provider_session_id,
      // The fork's OWN stable app-session row id — distinct from `sessionId`
      // above (the PARENT's provider-native id, used only as the resume
      // target). The Claude runtime's session pool keys its live process map
      // on this id, never the provider-native one (forks reassign that
      // mid-stream once the SDK announces the fork's own id).
      appSessionId: forked.sessionId,
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

      // The early write-back above (fired from `onProviderSessionId`) is the
      // common case; this retries only when that either never got a chance
      // to run or itself reported failure. Best-effort: naming must never
      // fail the fork run.
      let writeBackOk = earlyRenameWriteBack ? await earlyRenameWriteBack : false;
      if (!writeBackOk) {
        try {
          const retryResult = await sessionsService.renameSessionById(forked.sessionId, forkedName);
          writeBackOk = retryResult.writeBack;
        } catch (renameError) {
          const renameMessage = renameError instanceof Error ? renameError.message : String(renameError);
          console.warn('[Chat] Failed to write back forked session name', { sessionId: forked.sessionId, error: renameMessage });
        }
      }

      if (!writeBackOk) {
        // Both the announcement-time attempt and the post-spawn retry failed
        // (or the announcement never happened) — the fork's " (fork)" suffix
        // may be overwritten by the next sessions-watcher sync. Surface this
        // into the ORIGINAL session so the user knows to double-check/rename
        // manually, mirroring the shape of the other task_notification sends
        // in this function.
        sendIfOpen(ws, JSON.stringify(createNormalizedMessage({
          kind: 'task_notification',
          sessionId,
          provider,
          status: 'completed',
          summary: `Forked conversation completed, but its name may not persist as "${forkedName}" — a background sync could revert it. Rename it manually if needed.`,
        })));
      }
    } catch (error) {
      // The success ack above already told the user the fork was created, so
      // a spawn failure here must be surfaced too — otherwise the user is
      // left believing the fork is running when it silently died. Report
      // into the ORIGINAL session's transcript, mirroring the setup-failure
      // block above (same shape/fields).
      const message = error instanceof Error ? error.message : String(error);
      console.error('[Chat] /fork run failed', { sessionId: forked.sessionId, error: message });
      sendIfOpen(ws, JSON.stringify(createNormalizedMessage({
        kind: 'task_notification',
        sessionId,
        provider,
        status: 'failed',
        summary: `Forked conversation failed to start: ${message}`,
      })));
    } finally {
      chatRunRegistry.completeRunIfCurrent(forkRun, { exitCode: 1 });
    }
    return;
  }

  const run = chatRunRegistry.startRun({
    appSessionId: sessionId,
    provider,
    providerSessionId: session.provider_session_id,
    connection: ws,
    userId,
    forkMeta: editAtMessageUuid
      ? {
          parentSessionId: sessionId,
          parentProviderSessionId: session.provider_session_id as string,
          // The fork ANCHOR: the resume-point assistant uuid, which — unlike
          // the edited user uuid — is copied into every sibling transcript,
          // so the branch switcher can render in any branch. Null for
          // first-prompt edits (no shared history ⇒ no switcher).
          forkedAtMessageUuid: forkResumeSessionAt,
          projectPath: session.project_path ?? '',
        }
      : undefined,
  });

  if (!run) {
    sendProtocolError(
      ws,
      'RUN_IN_PROGRESS',
      `Session "${sessionId}" already has a run in progress.`,
      sessionId
    );
    return;
  }

  let command = typeof data.content === 'string' ? data.content : '';

  const subtaskCommand = provider === 'claude' ? parseSubtaskCommand(command) : null;
  if (subtaskCommand) {
    // /subtask maps to the fork subagent (inherits full conversation context).
    command = buildSubtaskPrompt(subtaskCommand.task);
  }

  // The provider runtimes receive the provider-native session id (that is the
  // id their CLI/SDK understands for resume). Brand-new sessions have no
  // provider id yet, so the runtime starts fresh and announces one, which the
  // gateway writer captures and maps back to the app session id.
  const runtimeOptions: AnyRecord = {
    ...clientOptions,
    // Image attachments are re-validated server-side: only files inside the
    // global upload store may reach the provider runtimes' file reads.
    images: filterImagesToUploadStore(clientOptions.images),
    sessionId: session.provider_session_id ?? undefined,
    // The stable app-session row id, distinct from `sessionId` above. The
    // Claude runtime's session pool keys its live process map on this id so
    // background shells survive a mid-conversation provider-id change (forks
    // reassign the provider id once the SDK announces the fork's own).
    appSessionId: sessionId,
    resume: Boolean(session.provider_session_id),
    cwd: clientOptions.cwd ?? session.project_path ?? undefined,
    projectPath: session.project_path ?? clientOptions.projectPath,
    ...buildForkRuntimeOptions(editAtMessageUuid, forkResumeSessionAt),
    // /subtask is the only caller that needs the fork subagent env vars —
    // scoped to this run only (see mapCliOptionsToSDK for why).
    ...(subtaskCommand ? { forkSubagent: true } : {}),
  };
  delete runtimeOptions.editAtMessageUuid;

  try {
    await spawnFn(command, runtimeOptions, run.writer);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Chat] Provider runtime "${provider}" failed`, { sessionId, error: message });
  } finally {
    // Safety net: a runtime that crashed (or resolved) without emitting its
    // terminal `complete` would otherwise leave the session stuck in
    // "processing" forever on every connected client. Scoped to THIS run —
    // a queued message can start the session's next run before this promise
    // settles, and the session-keyed completeRun would kill that new run.
    chatRunRegistry.completeRunIfCurrent(run, { exitCode: 1 });
  }
}

/**
 * Handles `chat.abort`: cancels the run for one app session and emits the
 * terminal `complete` on its behalf (runtimes skip their own complete for
 * aborted runs, and the registry drops any duplicate).
 */
async function handleChatAbort(
  ws: WebSocket,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): Promise<void> {
  const sessionId = readRequiredSessionId(data);
  if (!sessionId) {
    sendProtocolError(ws, 'SESSION_ID_REQUIRED', 'chat.abort requires a sessionId.');
    return;
  }

  const run = chatRunRegistry.getRun(sessionId);
  if (!run || run.status !== 'running') {
    sendProtocolError(ws, 'NO_ACTIVE_RUN', `Session "${sessionId}" has no active run.`, sessionId);
    return;
  }

  const abortFn = dependencies.abortFns[run.provider];
  let success = false;
  if (abortFn && run.providerSessionId) {
    success = Boolean(await abortFn(run.providerSessionId));
  }

  chatRunRegistry.completeRun(sessionId, {
    exitCode: success ? 0 : 1,
    aborted: true,
  });
}

/**
 * Handles `chat.subscribe`: for each requested session, reports whether a run
 * is processing, re-attaches the live stream to this socket, replays missed
 * events (seq > lastSeq), and includes pending permission requests.
 *
 * This single message replaces the old `check-session-status`,
 * `get-pending-permissions`, and Claude-only writer reconnect flows.
 */
function handleChatSubscribe(
  ws: WebSocket,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): void {
  const targets = Array.isArray(data.sessions) ? data.sessions : [];

  for (const target of targets) {
    if (!target || typeof target !== 'object') {
      continue;
    }

    const sessionId = typeof (target as AnyRecord).sessionId === 'string'
      ? ((target as AnyRecord).sessionId as string).trim()
      : '';
    if (!sessionId) {
      continue;
    }

    const lastSeqRaw = (target as AnyRecord).lastSeq;
    const lastSeq = typeof lastSeqRaw === 'number' && Number.isFinite(lastSeqRaw)
      ? Math.max(0, Math.floor(lastSeqRaw))
      : 0;

    const run = chatRunRegistry.getRun(sessionId);
    const isProcessing = chatRunRegistry.isProcessing(sessionId);

    // Future live events for this run should land on the socket that asked —
    // this is what makes mid-stream page refreshes work for all providers.
    if (isProcessing) {
      chatRunRegistry.attachConnection(sessionId, ws);
    }

    // Pending approvals are tracked under the provider-native id inside the
    // Claude runtime; remap their sessionId so the client only sees app ids.
    const pendingPermissions = (run?.providerSessionId
      ? dependencies.getPendingApprovalsForSession(run.providerSessionId)
      : []
    ).map((approval) =>
      approval && typeof approval === 'object'
        ? { ...(approval as AnyRecord), sessionId }
        : approval,
    );

    sendJson(ws, {
      kind: 'chat_subscribed',
      sessionId,
      isProcessing,
      lastSeq: run?.lastSeq ?? 0,
      pendingPermissions,
      timestamp: new Date().toISOString(),
    });

    // Replay only for RUNNING runs, strictly after the ack. Completed runs
    // are fully persisted to the provider transcript and served over REST —
    // replaying them (e.g. after a page reload where the client's lastSeq is
    // 0) would duplicate messages the history fetch already returned.
    if (isProcessing) {
      for (const event of chatRunRegistry.replayEvents(sessionId, lastSeq)) {
        sendJson(ws, event);
      }
    }
  }
}

/**
 * Handles `chat.permission-response`: forwards a tool-approval decision to the
 * pending approval resolver (Claude is the only provider with interactive
 * approvals today, but the message is intentionally provider-neutral).
 */
function handlePermissionResponse(data: AnyRecord, dependencies: ChatWebSocketDependencies): void {
  if (typeof data.requestId !== 'string' || data.requestId.length === 0) {
    return;
  }

  dependencies.resolveToolApproval(data.requestId, {
    allow: Boolean(data.allow),
    updatedInput: data.updatedInput,
    message: typeof data.message === 'string' ? data.message : undefined,
    rememberEntry: data.rememberEntry,
  });
}

/**
 * Handles authenticated chat websocket messages used by the main chat panel.
 *
 * Inbound protocol (client to server):
 * - `chat.send`                { sessionId, content, options? }
 * - `chat.abort`               { sessionId }
 * - `chat.subscribe`           { sessions: [{ sessionId, lastSeq? }] }
 * - `chat.permission-response` { requestId, allow, updatedInput?, message?, rememberEntry? }
 *
 * Outbound protocol (server to client): every frame is `kind`-based — either
 * a provider `NormalizedMessage` (with `seq`) or a gateway event
 * (`chat_subscribed`, `session_upserted`, `loading_progress`,
 * `protocol_error`).
 */
export function handleChatConnection(
  ws: WebSocket,
  request: AuthenticatedWebSocketRequest,
  dependencies: ChatWebSocketDependencies
): void {
  console.log('[INFO] Chat WebSocket connected');

  const userId = readRequestUserId(request);
  // Stamp the identity onto the connection BEFORE it joins the set: a
  // broadcaster carrying per-user content (background_task) reads it off the set
  // entries, and the raw socket has no identity of its own. Mutating the socket
  // rather than adding a parallel map keeps `connectedClients.delete(ws)` on
  // close as the only cleanup there is.
  (ws as RealtimeClientConnection).userId = userId;
  connectedClients.add(ws);

  ws.on('message', async (rawMessage) => {
    try {
      const parsed = parseIncomingJsonObject(rawMessage);
      if (!parsed) {
        throw new Error('Invalid websocket payload');
      }

      const data = parsed as AnyRecord;
      const messageType = typeof data.type === 'string' ? data.type : '';

      switch (messageType) {
        case 'chat.send':
          await handleChatSend(ws, userId, data, dependencies);
          return;
        case 'chat.abort':
          await handleChatAbort(ws, data, dependencies);
          return;
        case 'chat.subscribe':
          handleChatSubscribe(ws, data, dependencies);
          return;
        case 'chat.permission-response':
          handlePermissionResponse(data, dependencies);
          return;
        default:
          sendProtocolError(ws, 'UNKNOWN_MESSAGE_TYPE', `Unknown message type "${messageType}".`);
          return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ERROR] Chat WebSocket error:', message);
      sendProtocolError(ws, 'INTERNAL_ERROR', message);
    }
  });

  ws.on('close', () => {
    console.log('[INFO] Chat client disconnected');
    connectedClients.delete(ws);
  });
}
