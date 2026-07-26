/* eslint react/jsx-no-bind: ["error", { "ignoreDOMComponents": true, "allowArrowFunctions": false, "allowFunctions": false, "allowBind": false }] --
 * Referential stability at the message-list boundary. Props declared here
 * reach every rendered message row, and a row re-render re-runs the markdown
 * pipeline plus one React element per syntax-highlight token (~10 spans per
 * line of code). One inline arrow prop turns a keystroke into a full
 * re-render of the visible transcript — measured at 1456ms INP before the
 * memo boundaries went in. `React.memo` on the rows only holds while every
 * prop keeps its identity, and nothing else enforces that. Host elements are
 * exempt: they have no memo boundary to break. See CLAUDE.md > Gotchas.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDownIcon } from 'lucide-react';

import { useTasksSettings } from '../../../contexts/TasksSettingsContext';
import { useWebSocket } from '../../../contexts/WebSocketContext';
import { useSessionLock } from '../../../contexts/SessionLockContext';
import PermissionContext from '../../../contexts/PermissionContext';
import { QuickSettingsPanel } from '../../quick-settings-panel';
import type { ChatInterfaceProps, ChatMessage, Provider  } from '../types/types';
import { useChatProviderState } from '../hooks/useChatProviderState';
import { useChatSessionState } from '../hooks/useChatSessionState';
import { useChatRealtimeHandlers } from '../hooks/useChatRealtimeHandlers';
import { useChatComposerState } from '../hooks/useChatComposerState';
import { useSessionStore } from '../../../stores/useSessionStore';
import type { NormalizedMessage } from '../../../stores/useSessionStore';
import { postStopSession } from '../../../contexts/sessionLockApi';
import { api } from '../../../utils/api';
import {
  baseMessageUuid,
  firstUserMessageUuid,
  pickBranchIndex,
  pickBranchSwitcherOwners,
} from '../utils/branchAnchors';
import { useBranchSwitchController } from '../hooks/useBranchSwitchController';

import ChatMessagesPane from './subcomponents/ChatMessagesPane';
import ChatComposer from './subcomponents/ChatComposer';
import CommandResultModal from './subcomponents/CommandResultModal';
import { BranchSwitcher, type BranchSwitchMeta } from './subcomponents/BranchSwitcher';

/** A row from `GET /api/providers/sessions/:id/branches`. */
type SessionBranch = {
  sessionId: string;
  forkedFromSessionId: string | null;
  forkedAtMessageUuid: string | null;
  createdAt: string;
  activeLeaf: boolean;
};

function ChatInterface({
  selectedProject,
  selectedSession,
  ws,
  sendMessage,
  onFileOpen,
  onInputFocusChange,
  onSessionProcessing,
  onSessionIdle,
  processingSessions,
  onNavigateToSession,
  onSessionEstablished,
  onShowSettings,
  showRawParameters,
  showThinking,
  sendByCtrlEnter,
  externalMessageUpdate,
  newSessionTrigger,
  onShowAllTasks,
}: ChatInterfaceProps) {
  const { tasksEnabled, isTaskMasterInstalled } = useTasksSettings();
  const { subscribe } = useWebSocket();
  const { t } = useTranslation('chat');

  const sessionStore = useSessionStore();
  // Keyed by session id: concurrent sessions can stream at the same time, so a
  // single shared buffer/timer would cross-contaminate their accumulated text.
  const streamTimerRef = useRef(new Map<string, number>());
  const accumulatedStreamRef = useRef(new Map<string, string>());
  // When each session's `chat.subscribe` was last sent; idle acks older than
  // a later local request are discarded as stale.
  const statusCheckSentAtRef = useRef(new Map<string, number>());
  // Highest live `seq` observed per session. Written by the realtime handler
  // on every sequenced frame, read whenever a `chat.subscribe` is sent so the
  // server replays only the events this client actually missed.
  const lastSeqRef = useRef(new Map<string, number>());

  // Per-session entries are otherwise only ever cleared by that session's own
  // stream_end/complete — this is just the full-teardown path for unmount.
  const resetStreamingState = useCallback(() => {
    streamTimerRef.current.forEach((timer) => clearTimeout(timer));
    streamTimerRef.current.clear();
    accumulatedStreamRef.current.clear();
  }, []);

  const {
    provider,
    setProvider,
    cursorModel,
    setCursorModel,
    claudeModel,
    setClaudeModel,
    codexModel,
    setCodexModel,
    currentProviderEffort,
    currentProviderEffortOptions,
    opencodeModel,
    setOpenCodeModel,
    permissionMode,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    cyclePermissionMode,
    providerModelCatalog,
    providerModelCacheCatalog,
    isProviderAuthenticated,
    providerModelsLoading,
    providerModelsRefreshing,
    hardRefreshProviderModels,
    selectProviderModel,
    setStoredProviderEffort,
    resolvePermissionModeForProvider,
  } = useChatProviderState({
    selectedSession,
    selectedProject,
  });

  const {
    chatMessages,
    addMessage,
    sessionActivity,
    isProcessing,
    canAbortSession,
    currentSessionId,
    setCurrentSessionId,
    isLoadingSessionMessages,
    isLoadingMoreMessages,
    hasMoreMessages,
    totalMessages,
    isUserScrolledUp,
    setIsUserScrolledUp,
    tokenBudget,
    setTokenBudget,
    visibleMessageCount,
    visibleMessages,
    loadEarlierMessages,
    loadAllMessages,
    allMessagesLoaded,
    isLoadingAllMessages,
    loadAllJustFinished,
    showLoadAllOverlay,
    createDiff,
    scrollContainerRef,
    scrollToBottom,
    scrollToBottomAndReset,
    handleScroll,
    beginForkView,
    clearForkView,
  } = useChatSessionState({
    selectedProject,
    selectedSession,
    ws,
    sendMessage,
    externalMessageUpdate,
    newSessionTrigger,
    processingSessions,
    onSessionIdle,
    statusCheckSentAtRef,
    lastSeqRef,
    sessionStore,
  });

  // Brand-new conversation: the composer allocated a stable session id via
  // the session gateway before the first send. Record it locally and put it
  // in the URL — this id never changes again, so there is no later handoff.
  const handleSessionEstablished = useCallback<NonNullable<ChatInterfaceProps['onSessionEstablished']>>((sessionId, context) => {
    setCurrentSessionId(sessionId);
    onSessionEstablished?.(sessionId, context);
    onNavigateToSession?.(sessionId);
  }, [setCurrentSessionId, onSessionEstablished, onNavigateToSession]);

  // Sibling branches for the viewed session, refetched whenever the viewed
  // session changes (including the swap `onBranchCreated` performs below).
  const [branches, setBranches] = useState<SessionBranch[]>([]);
  // Guards a fetch's result against being applied after the session it was
  // fetched for has stopped being the one in view (stale in-flight response).
  const currentSessionIdRef = useRef(currentSessionId);
  useEffect(() => {
    currentSessionIdRef.current = currentSessionId;
  }, [currentSessionId]);

  // Read at click time, never rendered. `isProcessing` flips twice per message
  // sent, so gating the ✏️ button with it — as a `canEditPrompt` prop or as a
  // `useCallback` dep on the click handler — invalidates `React.memo` on EVERY
  // message row twice per send. The row props stay constant instead and the
  // run-in-progress check moves into `handleEditPrompt` below.
  const isProcessingRef = useRef(isProcessing);
  useEffect(() => {
    isProcessingRef.current = isProcessing;
  }, [isProcessing]);

  // A failed lookup must not be rendered as "this session has no branches".
  // Both states used to collapse to `[]`, so a transient 500 on one of the
  // refetches below (a failed branch activation, or a re-read after a fork
  // resolved) removed the switcher — the only way back to the sibling turns —
  // and left the conversation looking like an ordinary un-forked one. Those
  // refetches keep the last known list instead.
  //
  // This does NOT extend to a session change: the effect below clears the list
  // before the new session's fetch starts, so a failure there still shows no
  // switcher. That is the correct trade — the alternative is rendering another
  // session's branches over this one.
  //
  // `isCurrent()` is re-checked after BOTH awaits. Checking only after the
  // request resolves leaves a window where the headers arrive while the
  // session is still current, `json()` takes a moment, and the body lands
  // after the user has moved on — measured as session A's empty list wiping a
  // 3-branch switcher out of session B's view.
  const fetchBranches = useCallback(async (sessionId: string, isCurrent: () => boolean) => {
    try {
      const response = await api.sessionBranches(sessionId);
      if (!isCurrent()) return;
      if (!response.ok) {
        console.error('[ChatInterface] Session branches lookup failed', {
          sessionId,
          status: response.status,
        });
        return;
      }
      const json = await response.json();
      if (!isCurrent()) return;
      setBranches(json?.data?.branches ?? []);
    } catch (error) {
      if (!isCurrent()) return;
      console.error('[ChatInterface] Failed to fetch session branches', error);
    }
  }, []);

  useEffect(() => {
    if (!currentSessionId) {
      setBranches([]);
      return;
    }
    // Clearing unconditionally here is what made a transient 500 delete the
    // pager: `fetchBranches` keeps the last known list on failure, but this
    // effect had already emptied it, so a failed refetch left the session
    // looking un-forked — and the sidebar shows one row per cluster, so the
    // sibling versions had no entry point left anywhere until a reload.
    // Every in-app route to a sibling (the pager, the post-fork swap) lands on
    // a session that is already IN the loaded list, so keeping that list while
    // the refetch is in flight shows the same cluster it belongs to. A session
    // outside the list is a different conversation and still starts empty —
    // rendering the previous conversation's branches over it would be worse.
    setBranches((previous) => (
      previous.some((branch) => branch.sessionId === currentSessionId) ? previous : []
    ));
    let cancelled = false;
    void fetchBranches(currentSessionId, () => !cancelled);
    return () => {
      cancelled = true;
    };
  }, [currentSessionId, fetchBranches]);

  // Alternatives at a fork point `uuid`: every branch forked at that message,
  // plus the common parent they split from, parent-first then by createdAt.
  // Deduped by sessionId: a branch can be BOTH a fork at this anchor and the
  // parent of a later fork at the same anchor (fork-of-fork), and must count
  // once or the switcher's total/index drift onto duplicates.
  const siblingsAt = useCallback((uuid: string) => {
    const forks = branches.filter((b) => b.forkedAtMessageUuid === uuid);
    if (forks.length === 0) return [];
    const parentIds = [...new Set(forks.map((b) => b.forkedFromSessionId).filter(Boolean))] as string[];
    const parents = branches.filter((b) => parentIds.includes(b.sessionId));
    const seen = new Set<string>();
    return [...parents, ...forks].filter((b) => {
      if (seen.has(b.sessionId)) return false;
      seen.add(b.sessionId);
      return true;
    });
  }, [branches]);

  // One owner for the whole switch lifecycle: what the live region says (it has
  // to live outside the message list, because the pager's subtree is replaced on
  // every switch and a live region inserted together with its text is not
  // reliably announced), and which pager may take focus back afterwards.
  const formatBranchAnnouncement = useCallback(
    (current: number, total: number) => t('branch.announced', { current, total }),
    [t],
  );
  const {
    announcement: branchAnnouncement,
    begin: beginBranchSwitch,
    commit: commitBranchSwitch,
    abort: abortBranchSwitch,
  } = useBranchSwitchController({ currentSessionId, formatAnnouncement: formatBranchAnnouncement });

  /** Set when a fork is rejected, so the composer can say so on screen. */
  const [forkError, setForkError] = useState<string | null>(null);
  const dismissForkError = useCallback(() => setForkError(null), []);

  // Every fork error describes something that happened in ONE conversation, but
  // `ChatInterface` is mounted once for the whole app (MainContent renders it
  // without a `key`), so the banner outlived the session it belonged to: a
  // failed switch in A left "Could not switch versions" pinned above B's
  // composer, describing an action never taken there. The successful paths
  // already clear it; only leaving did not.
  useEffect(() => {
    setForkError(null);
  }, [currentSessionId]);

  /**
   * Sessions with a fork submitted and not yet resolved, mapped to the provider
   * that ran it. The socket is shared by every open session, so "is a fork in
   * flight?" cannot be answered by state derived from the VIEWED session —
   * doing that reported a background run's `complete` as a failed fork in a
   * session that never forked, and reported a real unhonored fork nowhere at
   * all once the user had navigated away. An entry is removed by exactly one
   * of the three outcomes below: branch created, fork failed, run completed.
   */
  const pendingForkRef = useRef<Map<string, Provider>>(new Map());
  const handleForkSubmitted = useCallback((uuid: string) => {
    const sid = currentSessionIdRef.current;
    if (sid) {
      pendingForkRef.current.set(sid, provider);
    }
    beginForkView(uuid);
  }, [beginForkView, provider]);

  const switchBranch = useCallback(async (branchSessionId: string | undefined, meta: BranchSwitchMeta) => {
    if (!branchSessionId) return;
    // Snapshot before the first await: modality, the pager pressed and the
    // session in view are all only true of the moment the chevron went down.
    const request = beginBranchSwitch(meta, currentSessionIdRef.current);
    try {
      const response = await api.activateBranch(branchSessionId);
      if (!response.ok) {
        console.error('Branch activation failed', { branchSessionId, status: response.status });
        abortBranchSwitch(request);
        // Without this the transcript, the counter and the focus are all
        // unchanged, so the chevron reads as a dead button.
        setForkError(t('branch.switchFailed'));
        if (currentSessionId) {
          void fetchBranches(currentSessionId, () => currentSessionIdRef.current === currentSessionId);
        }
        return;
      }
      setForkError(null);
      // Everything the snapshot promised is re-checked here. A false means the
      // user has left this conversation while the request was in flight: the
      // branch is activated server-side, but pulling the route and the focus
      // back into a session they walked away from is the defect, not the fix.
      if (!commitBranchSwitch(request, branchSessionId, { current: meta.targetIndex, total: meta.total })) {
        return;
      }
      await sessionStore.refreshFromServer(branchSessionId);
      // The same rule as the check above, because this is a SECOND await and
      // the user can leave during it too. `commit` validated the snapshot
      // before the refresh, not after it; everything below rewrites the route,
      // so running it here dragged the user out of whatever they had opened in
      // the meantime — and with `replace: true`, deleted that history entry on
      // the way out. The branch stays activated server-side either way; the
      // controller has already retracted the focus claim and the announcement
      // when the session changed under it.
      if (currentSessionIdRef.current !== request.fromSessionId) {
        return;
      }
      sessionStore.setActiveSession(branchSessionId);
      setCurrentSessionId(branchSessionId);
      onNavigateToSession?.(branchSessionId, { replace: true });
      clearForkView();
    } catch (error) {
      console.error('[ChatInterface] Branch switch failed', error);
      // A claim made just above must not outlive the refresh that threw, or it
      // waits for whatever pager mounts next and steals focus into it.
      abortBranchSwitch(request);
      setForkError(t('branch.switchFailed'));
      if (currentSessionId) {
        void fetchBranches(currentSessionId, () => currentSessionIdRef.current === currentSessionId);
      }
    }
  }, [sessionStore, setCurrentSessionId, onNavigateToSession, clearForkView, currentSessionId, fetchBranches, t,
    beginBranchSwitch, commitBranchSwitch, abortBranchSwitch]);

  // `renderedMessageId -> anchorUuid`: the switcher belongs to the user prompt
  // that differs between siblings, not to the shared assistant resume point the
  // anchor names (see pickBranchSwitcherOwners for the measurements).
  // `visibleMessages` gets a new reference on every stream flush (~100ms), so
  // the recomputed Map is swapped in only when its CONTENT changed — a stable
  // reference keeps `renderBranchSwitcher`'s identity, which is what lets
  // `React.memo` on the message rows keep working during streaming.
  const switcherOwnersRef = useRef<Map<string, string>>(new Map());
  const switcherOwners = useMemo(() => {
    const next = pickBranchSwitcherOwners(visibleMessages, branches.map((b) => b.forkedAtMessageUuid));
    const prev = switcherOwnersRef.current;
    if (prev.size === next.size && [...next].every(([id, anchor]) => prev.get(id) === anchor)) {
      return prev;
    }
    switcherOwnersRef.current = next;
    return next;
  }, [visibleMessages, branches]);

  // The first prompt of a conversation cannot be edit-forked (no preceding
  // assistant turn to anchor the resume point on) — hide its ✏️ button.
  // Computed over the full loaded list (not the visible tail slice); while
  // older history is still unloaded, nothing on screen can be the first
  // message and everything stays editable.
  const editBlockedUuid = useMemo(
    () => firstUserMessageUuid(chatMessages, hasMoreMessages),
    [chatMessages, hasMoreMessages],
  );

  const renderBranchSwitcher = useCallback((message: ChatMessage) => {
    if (!message.uuid) return null;
    // Keyed by the RENDERED id, not the base uuid: the owning prompt is a
    // different message from the anchor it switches at.
    const anchor = switcherOwners.get(message.uuid);
    if (!anchor) return null;
    const sibs = siblingsAt(anchor);
    if (sibs.length < 2) return null;
    const idx = pickBranchIndex(sibs, currentSessionId);
    if (idx < 0) return null;
    return (
      <BranchSwitcher
        current={idx + 1}
        total={sibs.length}
        anchor={anchor}
        prevSessionId={sibs[idx - 1]?.sessionId}
        nextSessionId={sibs[idx + 1]?.sessionId}
        onSwitch={switchBranch}
      />
    );
  }, [switcherOwners, siblingsAt, currentSessionId, switchBranch]);

  const {
    input,
    setInput,
    textareaRef,
    inputHighlightRef,
    isTextareaExpanded,
    slashCommandsCount,
    slashCommandNames,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    showFileDropdown,
    filteredFiles,
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    attachedImages,
    setAttachedImages,
    uploadingImages,
    imageErrors,
    getRootProps,
    getInputProps,
    isDragActive,
    openImagePicker,
    handleSubmit,
    queuedDraft,
    editQueuedDraft,
    deleteQueuedDraft,
    handleVoiceTranscript,
    handleInputChange,
    handleKeyDown,
    handlePaste,
    handleTextareaClick,
    handleTextareaInput,
    syncInputOverlayScroll,
    handleClearInput,
    handleAbortSession,
    handlePermissionDecision,
    handleGrantToolPermission,
    handleInputFocusChange,
    isInputFocused,
    commandModalPayload,
    closeCommandModal,
    showCostModal,
    editingSentPrompt,
    startEditSentPrompt,
    cancelEditSentPrompt,
    restoreEditSentPrompt,
    clearEditSubmission,
  } = useChatComposerState({
    selectedProject,
    selectedSession,
    currentSessionId,
    provider,
    permissionMode,
    cyclePermissionMode,
    cursorModel,
    claudeModel,
    codexModel,
    currentProviderEffort,
    opencodeModel,
    isLoading: isProcessing,
    canAbortSession,
    tokenBudget,
    sendMessage,
    sendByCtrlEnter,
    onSessionProcessing,
    onSessionEstablished: handleSessionEstablished,
    onInputFocusChange,
    onFileOpen,
    onShowSettings,
    scrollToBottom,
    addMessage,
    setIsUserScrolledUp,
    setPendingPermissionRequests,
    resolvePermissionModeForProvider,
    onForkSubmitted: handleForkSubmitted,
  });

  // Stable identity matters: this is handed to every message row, and an
  // inline arrow here re-renders the whole list on each ChatInterface render.
  const handleEditPrompt = useCallback((message: ChatMessage) => {
    // The rendered uuid is a part id (`<uuid>_text_<n>` for user text parts);
    // the server resolves the resume point by BARE transcript uuid, so strip
    // the part suffix before sending.
    if (!message.uuid) return;
    // Forking mid-run would race the stream that is still writing the
    // transcript being forked from. Checked here, through a ref, so the answer
    // costs no row prop and no dep on this callback's identity — and said out
    // loud in the composer, because a click that silently does nothing reads
    // as a broken button.
    if (isProcessingRef.current) {
      setForkError(t('branch.editBlockedWhileRunning'));
      return;
    }
    setForkError(null);
    startEditSentPrompt(baseMessageUuid(message.uuid), typeof message.content === 'string' ? message.content : '');
  }, [startEditSentPrompt, t]);

  // The remaining handlers below are hoisted out of JSX for the same reason:
  // `ChatMessagesPane` and `ChatComposer` are both memoized, and an inline
  // arrow prop defeats that on every render of this component.
  const handleSetProvider = useCallback((nextProvider: string) => {
    setProvider(nextProvider as Provider);
  }, [setProvider]);

  const handleSelectEffort = useCallback((nextEffort: string) => {
    setStoredProviderEffort(provider, nextEffort);
  }, [setStoredProviderEffort, provider]);

  const handleRemoveImage = useCallback((index: number) => {
    setAttachedImages((previous) => previous.filter((_, currentIndex) => currentIndex !== index));
  }, [setAttachedImages]);

  // On WebSocket reconnect, re-fetch the current session's messages from the
  // server so missed streaming events are shown, then re-subscribe — the
  // `chat_subscribed` ack restores or clears the activity indicator, replays
  // missed live events, and re-attaches a still-running stream to this socket.
  const handleWebSocketReconnect = useCallback(async () => {
    if (!selectedProject || !selectedSession) return;
    await sessionStore.refreshFromServer(selectedSession.id);
    statusCheckSentAtRef.current.set(selectedSession.id, Date.now());
    sendMessage({
      type: 'chat.subscribe',
      sessions: [{
        sessionId: selectedSession.id,
        lastSeq: lastSeqRef.current.get(selectedSession.id) ?? 0,
      }],
    });
  }, [selectedProject, selectedSession, sendMessage, sessionStore]);

  const onBranchCreated = useCallback((parentId: string, branchId: string) => {
    // The fork run streamed its live events under the PARENT's session id
    // (the run is registered against the parent for its whole lifetime), so
    // the parent's realtime slot now holds turns that only exist in the
    // branch's transcript. Drop them — unconditionally, BEFORE the viewed-
    // session guard below: the pollution exists whether or not the user is
    // still looking at the parent, and a backgrounded fork would otherwise
    // leave it behind for the next visit to the parent.
    sessionStore.clearRealtime(parentId);
    pendingForkRef.current.delete(parentId);
    // A fork landed, so any earlier failure notice is stale.
    setForkError(null);
    // Adopt in place only when the fork's parent is the session being viewed.
    // A backgrounded fork (user switched to another session before the run
    // finished — including an aborted run whose branch was already created)
    // must never yank the user out of the session they are looking at.
    if (currentSessionIdRef.current !== parentId) {
      return;
    }
    clearForkView();
    // In-place swap: the branch transcript already contains the copied
    // history, so pointing the view at it is the whole "switch". The view
    // is ultimately keyed off `selectedSession` (the router-derived prop),
    // so `setCurrentSessionId` alone isn't enough — route to the branch the
    // same way a brand-new session is adopted. Deliberately a PUSH (no
    // `replace`): the parent leaves the sidebar once its `active_leaf`
    // flips, so browser Back is the guaranteed way home to it.
    sessionStore.setActiveSession(branchId);
    setCurrentSessionId(branchId);
    onNavigateToSession?.(branchId);
    clearEditSubmission();
    void fetchBranches(branchId, () => currentSessionIdRef.current === branchId);
  }, [clearForkView, clearEditSubmission, sessionStore, setCurrentSessionId, onNavigateToSession, fetchBranches]);

  // The spec's error contract is three things — restore the view, keep the
  // edited text, say what happened. Only the first used to ship: the composer
  // is cleared at send time, so a failed fork silently destroyed the edit and
  // reported it to the console, where no user is looking.
  const onForkFailed = useCallback((sid: string, error: string) => {
    console.error('Fork failed:', sid, error);
    pendingForkRef.current.delete(sid);
    // Same rule as `onBranchCreated`: a fork failing in a session the user is
    // not looking at must not touch the session they ARE looking at. Without
    // this the restore overwrote the other session's composer with the edited
    // text and re-entered edit mode on a message uuid from the failed
    // session — submitting then sent that foreign anchor against this session.
    if (!sid || currentSessionIdRef.current !== sid) {
      return;
    }
    clearForkView();
    const restored = restoreEditSentPrompt();
    setForkError(
      restored
        ? t('branch.forkFailedRestored', { defaultValue: 'Could not fork the conversation. Your edited prompt is back in the composer.' })
        : t('branch.forkFailed', { defaultValue: 'Could not fork the conversation.' }),
    );
  }, [clearForkView, restoreEditSentPrompt, t]);

  const onCompleteWithoutBranch = useCallback((sid: string) => {
    // Every run on the socket ends with a `complete`, so the only thing that
    // makes this one a failed fork is a fork having been submitted for THIS
    // session. Gating on the viewed session's fork state instead injected a
    // fabricated fork error into whichever session happened to be on screen,
    // and stayed silent about a real unhonored fork the user had left behind.
    const forkProvider = sid ? pendingForkRef.current.get(sid) : undefined;
    if (!forkProvider) return;
    pendingForkRef.current.delete(sid);
    console.error('Fork did not complete — restored the original view', sid);
    // Reuse the same in-conversation error surfacing as a protocol_error, in
    // the session that actually forked and under the provider that ran it.
    // Covers both an unhonored fork and an abort before the fork resolved.
    sessionStore.appendRealtime(sid, {
      id: `fork_not_honored_${Date.now()}`,
      sessionId: sid,
      timestamp: new Date().toISOString(),
      provider: forkProvider,
      kind: 'error',
      content: 'Fork did not complete — restored the original view.',
    } as NormalizedMessage);
    // The optimistic hiding belongs to the view; only unhide when this session
    // is the one on screen.
    if (currentSessionIdRef.current === sid) {
      clearForkView();
    }
  }, [clearForkView, sessionStore]);

  useChatRealtimeHandlers({
    subscribe,
    provider,
    selectedSession,
    currentSessionId,
    setTokenBudget,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    streamTimerRef,
    accumulatedStreamRef,
    lastSeqRef,
    statusCheckSentAtRef,
    onSessionProcessing,
    onSessionIdle,
    onWebSocketReconnect: handleWebSocketReconnect,
    sessionStore,
    onBranchCreated,
    onForkFailed,
    onCompleteWithoutBranch,
  });

  // Session lock (daemon-holds-the-roster) state for the active session.
  // `isLocked` is the render-time value; `isStopping` tracks the in-flight
  // POST so the Stop & Resume button can show a spinner without disabling
  // the underlying context update.
  const { isLocked: isSessionLocked, refreshSession } = useSessionLock();
  const [isStopping, setIsStopping] = useState(false);
  const activeSessionIdForLock = currentSessionId || selectedSession?.id || null;
  const isLocked = activeSessionIdForLock ? isSessionLocked(activeSessionIdForLock) : false;

  // Seed the lock state when a session becomes active. The WS delta stream
  // only reports *changes*; a session already locked before the view opened
  // would otherwise render as unlocked until something toggled the roster.
  useEffect(() => {
    if (!activeSessionIdForLock) return;
    refreshSession(activeSessionIdForLock);
  }, [activeSessionIdForLock, refreshSession]);

  const handleStopAndResume = useCallback(async () => {
    if (!activeSessionIdForLock || isStopping) return;
    setIsStopping(true);
    try {
      const result = await postStopSession(activeSessionIdForLock);
      if (result?.success && selectedSession?.id) {
        // Re-fetch the session so `isProcessing` flips back to false once
        // the daemon has dropped the worker. The WebSocket `unlocked` event
        // alone won't reset the activity indicator because that signal
        // only flows through `chat.session_upserted` on a transcript change.
        await sessionStore.refreshFromServer(selectedSession.id);
      } else if (!result?.success) {
        // Surface a non-blocking error — the lock is still held, the user
        // can retry. We log to console rather than throw because nothing in
        // the composer tree owns a toast channel; the warning bar stays
        // visible and the input stays disabled, which is the correct state.
        console.error('[SessionLock] Stop request failed', result?.message);
      }
    } catch (error) {
      console.error('[SessionLock] Stop request errored', error);
    } finally {
      setIsStopping(false);
    }
  }, [activeSessionIdForLock, isStopping, selectedSession, sessionStore]);

  // When the lock watcher reports this session is no longer locked (e.g.
  // because the user stopped it from `claude stop` in another terminal),
  // re-fetch the session so the activity indicator clears and the send
  // button becomes interactive again.
  useEffect(() => {
    if (!activeSessionIdForLock) return;
    if (isLocked) return;
    if (!selectedSession?.id) return;
    if (!isProcessing) return;
    sessionStore.refreshFromServer(selectedSession.id);
  }, [activeSessionIdForLock, isLocked, selectedSession, isProcessing, sessionStore]);

  useEffect(() => {
    if (!canAbortSession) {
      return;
    }

    const handleGlobalEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.repeat || event.defaultPrevented) {
        return;
      }

      event.preventDefault();
      handleAbortSession();
    };

    document.addEventListener('keydown', handleGlobalEscape, { capture: true });
    return () => {
      document.removeEventListener('keydown', handleGlobalEscape, { capture: true });
    };
  }, [canAbortSession, handleAbortSession]);

  useEffect(() => {
    return () => {
      resetStreamingState();
    };
  }, [resetStreamingState]);

  const permissionContextValue = useMemo(() => ({
    pendingPermissionRequests,
    handlePermissionDecision,
  }), [pendingPermissionRequests, handlePermissionDecision]);

  // Mirrors ChatComposer's own visibility check so the message pane can
  // reserve enough bottom space to keep the floating status tab from
  // overlapping the last message.
  const hasActivityIndicator = Boolean(sessionActivity && pendingPermissionRequests.length === 0);

  if (!selectedProject) {
    const selectedProviderLabel =
      provider === 'cursor'
        ? t('messageTypes.cursor')
        : provider === 'codex'
          ? t('messageTypes.codex')
          : provider === 'opencode'
              ? t('messageTypes.opencode', { defaultValue: 'OpenCode' })
            : t('messageTypes.claude');

    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center text-muted-foreground">
          <p className="text-sm">
            {t('projectSelection.startChatWithProvider', {
              provider: selectedProviderLabel,
              defaultValue: 'Select a project to start chatting with {{provider}}',
            })}
          </p>
        </div>
      </div>
    );
  }

  return (
    <PermissionContext.Provider value={permissionContextValue}>
      <div className="flex h-full min-h-0 flex-col">
        {/* One live region for the whole transcript, mounted for the lifetime
            of the view. The pager cannot host it: switching branches replaces
            the prompt the pager lives in, and a region inserted at the same
            moment as its text is not reliably announced — the switch went out
            silently for screen-reader users while a sighted user sees the
            entire transcript change. The text carries an invisible nonce so a
            switch back to a position already announced still mutates this node;
            an identical string is a no-op for `useState` and therefore silent.
            The controller also empties it on a session change, so another
            conversation never shows a position from this one. */}
        <span role="status" aria-live="polite" className="sr-only">
          {branchAnnouncement}
        </span>
        <ChatMessagesPane
          scrollContainerRef={scrollContainerRef}
          onWheel={handleScroll}
          onTouchMove={handleScroll}
          isLoadingSessionMessages={isLoadingSessionMessages}
          isProcessing={isProcessing}
          hasActivityIndicator={hasActivityIndicator}
          chatMessages={chatMessages}
          selectedSession={selectedSession}
          currentSessionId={currentSessionId}
          provider={provider}
          setProvider={handleSetProvider}
          textareaRef={textareaRef}
          claudeModel={claudeModel}
          setClaudeModel={setClaudeModel}
          cursorModel={cursorModel}
          setCursorModel={setCursorModel}
          codexModel={codexModel}
          setCodexModel={setCodexModel}
          opencodeModel={opencodeModel}
          setOpenCodeModel={setOpenCodeModel}
          providerModelCatalog={providerModelCatalog}
          providerModelsLoading={providerModelsLoading}
          isProviderAuthenticated={isProviderAuthenticated}
          tasksEnabled={tasksEnabled}
          isTaskMasterInstalled={isTaskMasterInstalled}
          onShowAllTasks={onShowAllTasks}
          setInput={setInput}
          isLoadingMoreMessages={isLoadingMoreMessages}
          hasMoreMessages={hasMoreMessages}
          totalMessages={totalMessages}
          sessionMessagesCount={chatMessages.length}
          visibleMessageCount={visibleMessageCount}
          visibleMessages={visibleMessages}
          loadEarlierMessages={loadEarlierMessages}
          loadAllMessages={loadAllMessages}
          allMessagesLoaded={allMessagesLoaded}
          isLoadingAllMessages={isLoadingAllMessages}
          loadAllJustFinished={loadAllJustFinished}
          showLoadAllOverlay={showLoadAllOverlay}
          createDiff={createDiff}
          onFileOpen={onFileOpen}
          onShowSettings={onShowSettings}
          onGrantToolPermission={handleGrantToolPermission}
          showRawParameters={showRawParameters}
          showThinking={showThinking}
          selectedProject={selectedProject}
          canEditPrompt={provider === 'claude'}
          editBlockedUuid={editBlockedUuid}
          onEditPrompt={handleEditPrompt}
          renderBranchSwitcher={renderBranchSwitcher}
        />

        <div className="relative flex-shrink-0">
          {isUserScrolledUp && chatMessages.length > 0 && (
            <div className="pointer-events-none absolute -top-11 left-0 right-0 z-20 flex justify-center">
              <button
                type="button"
                onClick={scrollToBottomAndReset}
                aria-label={t('input.scrollToBottom', { defaultValue: 'Scroll to bottom' })}
                className="pointer-events-auto flex h-8 w-8 items-center justify-center rounded-full border border-border/50 bg-card text-muted-foreground shadow-sm transition-all duration-200 hover:bg-accent hover:text-foreground"
                title={t('input.scrollToBottom', { defaultValue: 'Scroll to bottom' })}
              >
                <ArrowDownIcon className="h-4 w-4" aria-hidden />
              </button>
            </div>
          )}

          <ChatComposer
          pendingPermissionRequests={pendingPermissionRequests}
          handlePermissionDecision={handlePermissionDecision}
          handleGrantToolPermission={handleGrantToolPermission}
          chatMessages={chatMessages}
          activity={sessionActivity}
          isLoading={isProcessing}
          onAbortSession={handleAbortSession}
          permissionMode={permissionMode}
          onModeSwitch={cyclePermissionMode}
          effort={currentProviderEffort}
          availableEffortOptions={currentProviderEffortOptions}
          onSelectEffort={handleSelectEffort}
          tokenBudget={tokenBudget}
          onShowTokenUsage={showCostModal}
          slashCommandsCount={slashCommandsCount}
          onToggleCommandMenu={handleToggleCommandMenu}
          hasInput={Boolean(input.trim())}
          onClearInput={handleClearInput}
          onSubmit={handleSubmit}
          isDragActive={isDragActive}
          queuedDraft={queuedDraft}
          onEditQueuedDraft={editQueuedDraft}
          onDeleteQueuedDraft={deleteQueuedDraft}
          editingSentPrompt={editingSentPrompt}
          onCancelEditSentPrompt={cancelEditSentPrompt}
          forkError={forkError}
          onDismissForkError={dismissForkError}
          attachedImages={attachedImages}
          onRemoveImage={handleRemoveImage}
          uploadingImages={uploadingImages}
          imageErrors={imageErrors}
          showFileDropdown={showFileDropdown}
          filteredFiles={filteredFiles}
          selectedFileIndex={selectedFileIndex}
          onSelectFile={selectFile}
          filteredCommands={filteredCommands}
          selectedCommandIndex={selectedCommandIndex}
          onCommandSelect={handleCommandSelect}
          onCloseCommandMenu={resetCommandMenuState}
          isCommandMenuOpen={showCommandMenu}
          frequentCommands={commandQuery ? [] : frequentCommands}
          getRootProps={getRootProps as (...args: unknown[]) => Record<string, unknown>}
          getInputProps={getInputProps as (...args: unknown[]) => Record<string, unknown>}
          openImagePicker={openImagePicker}
          inputHighlightRef={inputHighlightRef}
          renderInputWithMentions={renderInputWithMentions}
          slashCommandNames={slashCommandNames}
          textareaRef={textareaRef}
          input={input}
          onVoiceTranscript={handleVoiceTranscript}
          onInputChange={handleInputChange}
          onTextareaClick={handleTextareaClick}
          onTextareaKeyDown={handleKeyDown}
          onTextareaPaste={handlePaste}
          onTextareaScrollSync={syncInputOverlayScroll}
          onTextareaInput={handleTextareaInput}
          isInputFocused={isInputFocused}
          onInputFocusChange={handleInputFocusChange}
          placeholder={t('input.placeholder', {
            provider:
              provider === 'cursor'
                ? t('messageTypes.cursor')
                : provider === 'codex'
                  ? t('messageTypes.codex')
                  : provider === 'opencode'
                      ? t('messageTypes.opencode', { defaultValue: 'OpenCode' })
                    : t('messageTypes.claude'),
          })}
          isTextareaExpanded={isTextareaExpanded}
          sendByCtrlEnter={sendByCtrlEnter}
          isLocked={isLocked}
          onStopAndResume={isLocked ? handleStopAndResume : undefined}
          isStopping={isStopping}
        />
        </div>
      </div>

      <QuickSettingsPanel />

      <CommandResultModal
        payload={commandModalPayload}
        onClose={closeCommandModal}
        providerModelCatalog={providerModelCatalog}
        providerModelCacheCatalog={providerModelCacheCatalog}
        providerModelsRefreshing={providerModelsRefreshing}
        onHardRefreshProviderModels={hardRefreshProviderModels}
        currentSessionId={currentSessionId || selectedSession?.id || null}
        onSelectProviderModel={selectProviderModel}
      />
    </PermissionContext.Provider>
  );
}

export default React.memo(ChatInterface);
