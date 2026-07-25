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
import { baseMessageUuid, firstUserMessageUuid, pickBranchAnchorMessageIds } from '../utils/branchAnchors';

import ChatMessagesPane from './subcomponents/ChatMessagesPane';
import ChatComposer from './subcomponents/ChatComposer';
import CommandResultModal from './subcomponents/CommandResultModal';
import { BranchSwitcher } from './subcomponents/BranchSwitcher';

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
  const streamTimerRef = useRef<number | null>(null);
  const accumulatedStreamRef = useRef('');
  // When each session's `chat.subscribe` was last sent; idle acks older than
  // a later local request are discarded as stale.
  const statusCheckSentAtRef = useRef(new Map<string, number>());
  // Highest live `seq` observed per session. Written by the realtime handler
  // on every sequenced frame, read whenever a `chat.subscribe` is sent so the
  // server replays only the events this client actually missed.
  const lastSeqRef = useRef(new Map<string, number>());

  const resetStreamingState = useCallback(() => {
    if (streamTimerRef.current) {
      clearTimeout(streamTimerRef.current);
      streamTimerRef.current = null;
    }
    accumulatedStreamRef.current = '';
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
    isForkViewActive,
  } = useChatSessionState({
    selectedProject,
    selectedSession,
    ws,
    sendMessage,
    externalMessageUpdate,
    newSessionTrigger,
    processingSessions,
    onSessionIdle,
    resetStreamingState,
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

  // A failed lookup must not be rendered as "this session has no branches".
  // Both states used to collapse to `[]`, so one transient 500 while viewing a
  // branch removed the switcher — the only way back to the sibling turns —
  // and left the conversation looking like an ordinary un-forked one. On
  // failure the last known list is kept instead; the session-change effect
  // below is what clears it, so a new session never inherits stale branches.
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
      setBranches(json?.data?.branches ?? []);
    } catch (error) {
      if (!isCurrent()) return;
      console.error('[ChatInterface] Failed to fetch session branches', error);
    }
  }, []);

  useEffect(() => {
    setBranches([]);
    if (!currentSessionId) {
      return;
    }
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

  const switchBranch = useCallback(async (branchSessionId?: string) => {
    if (!branchSessionId) return;
    try {
      const response = await api.activateBranch(branchSessionId);
      if (!response.ok) {
        console.error('Branch activation failed', { branchSessionId, status: response.status });
        if (currentSessionId) {
          void fetchBranches(currentSessionId, () => currentSessionIdRef.current === currentSessionId);
        }
        return;
      }
      await sessionStore.refreshFromServer(branchSessionId);
      sessionStore.setActiveSession(branchSessionId);
      setCurrentSessionId(branchSessionId);
      onNavigateToSession?.(branchSessionId, { replace: true });
      clearForkView();
    } catch (error) {
      console.error('[ChatInterface] Branch switch failed', error);
      if (currentSessionId) {
        void fetchBranches(currentSessionId, () => currentSessionIdRef.current === currentSessionId);
      }
    }
  }, [sessionStore, setCurrentSessionId, onNavigateToSession, clearForkView, currentSessionId, fetchBranches]);

  // Anchors are BARE transcript uuids, but array-content assistant messages
  // render as parts with `<uuid>_<partIndex>` ids — match on base uuid and
  // hang the switcher on exactly one part per turn (the last assistant part).
  // `visibleMessages` gets a new reference on every stream flush (~100ms), so
  // the recomputed Map is swapped in only when its CONTENT changed — a stable
  // reference keeps `renderBranchSwitcher`'s identity, which is what lets
  // `React.memo` on the message rows keep working during streaming.
  const anchorMessageIdsRef = useRef<Map<string, string>>(new Map());
  const anchorMessageIds = useMemo(() => {
    const next = pickBranchAnchorMessageIds(visibleMessages, branches.map((b) => b.forkedAtMessageUuid));
    const prev = anchorMessageIdsRef.current;
    if (prev.size === next.size && [...next].every(([anchor, id]) => prev.get(anchor) === id)) {
      return prev;
    }
    anchorMessageIdsRef.current = next;
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
    const anchor = baseMessageUuid(message.uuid);
    if (anchorMessageIds.get(anchor) !== message.uuid) return null;
    const sibs = siblingsAt(anchor);
    if (sibs.length < 2) return null;
    const idx = sibs.findIndex((b) => b.sessionId === currentSessionId || b.activeLeaf);
    if (idx < 0) return null;
    return (
      <BranchSwitcher
        current={idx + 1}
        total={sibs.length}
        prevSessionId={sibs[idx - 1]?.sessionId}
        nextSessionId={sibs[idx + 1]?.sessionId}
        onSwitch={switchBranch}
      />
    );
  }, [anchorMessageIds, siblingsAt, currentSessionId, switchBranch]);

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
    onForkSubmitted: beginForkView,
  });

  // Stable identity matters: this is handed to every message row, and an
  // inline arrow here re-renders the whole list on each ChatInterface render.
  const handleEditPrompt = useCallback((message: ChatMessage) => {
    // The rendered uuid is a part id (`<uuid>_text_<n>` for user text parts);
    // the server resolves the resume point by BARE transcript uuid, so strip
    // the part suffix before sending.
    if (!message.uuid) return;
    startEditSentPrompt(baseMessageUuid(message.uuid), typeof message.content === 'string' ? message.content : '');
  }, [startEditSentPrompt]);

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
    void fetchBranches(branchId, () => currentSessionIdRef.current === branchId);
  }, [clearForkView, sessionStore, setCurrentSessionId, onNavigateToSession, fetchBranches]);

  const onForkFailed = useCallback((_sid: string, error: string) => {
    clearForkView();
    console.error('Fork failed:', error);
  }, [clearForkView]);

  const onCompleteWithoutBranch = useCallback((sid: string) => {
    if (!isForkViewActive) return;
    clearForkView();
    console.error('Fork did not complete — restored the original view');
    // Reuse the same in-conversation error surfacing as a protocol_error.
    // Covers both an unhonored fork and an abort before the fork resolved.
    sessionStore.appendRealtime(sid, {
      id: `fork_not_honored_${Date.now()}`,
      sessionId: sid,
      timestamp: new Date().toISOString(),
      provider,
      kind: 'error',
      content: 'Fork did not complete — restored the original view.',
    } as NormalizedMessage);
  }, [isForkViewActive, clearForkView, sessionStore, provider]);

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
          canEditPrompt={provider === 'claude' && !isProcessing}
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
