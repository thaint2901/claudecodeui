import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Dispatch,
  FormEvent,
  KeyboardEvent,
  MouseEvent,
  SetStateAction,
  TouchEvent,
} from 'react';

import type { MarkSessionProcessing } from '../../../hooks/useSessionProtection';
import { safeLocalStorage } from '../utils/chatStorage';
import type {
  ChatMessage,
  PendingPermissionRequest,
  PermissionMode,
  SessionEstablishedContext,
} from '../types/types';
import type { Project, ProjectSession, LLMProvider } from '../../../types/app';

import { useFileMentions } from './useFileMentions';
import { useSlashCommands } from './useSlashCommands';
import { useComposerActions } from './composer/useComposerActions';
import { useComposerAttachments } from './composer/useComposerAttachments';
import { useComposerDraft } from './composer/useComposerDraft';
import { useEditSentPromptFork } from './composer/useEditSentPromptFork';
import { useMessageQueue, type QueuedDraft } from './composer/useMessageQueue';
import { useSlashDispatch } from './composer/useSlashDispatch';
import { useSubmitPipeline } from './composer/useSubmitPipeline';

export type { QueuedDraft };

interface UseChatComposerStateArgs {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  provider: LLMProvider;
  permissionMode: PermissionMode | string;
  cyclePermissionMode: () => void;
  resolvePermissionModeForProvider: (provider: LLMProvider, requestedMode: PermissionMode | string) => PermissionMode;
  cursorModel: string;
  claudeModel: string;
  codexModel: string;
  currentProviderEffort: string;
  opencodeModel: string;
  isLoading: boolean;
  canAbortSession: boolean;
  tokenBudget: Record<string, unknown> | null;
  sendMessage: (message: unknown) => void;
  sendByCtrlEnter?: boolean;
  onSessionProcessing?: MarkSessionProcessing;
  /**
   * Invoked with the freshly allocated session id when the user sends the
   * first message of a brand-new conversation. The backend allocates the id
   * via POST /api/providers/sessions BEFORE the websocket send, so the id is
   * stable for the conversation's whole lifetime — the consumer navigates to
   * /session/:id and records it as the current session.
   */
  onSessionEstablished?: (sessionId: string, context: SessionEstablishedContext) => void;
  onInputFocusChange?: (focused: boolean) => void;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  scrollToBottom: () => void;
  addMessage: (msg: ChatMessage) => void;
  setIsUserScrolledUp: (isScrolledUp: boolean) => void;
  setPendingPermissionRequests: Dispatch<SetStateAction<PendingPermissionRequest[]>>;
  /** Called right after an edit-and-fork request is sent, with the edited message's uuid. */
  onForkSubmitted?: (uuid: string) => void;
}

interface MentionableFile {
  name: string;
  path: string;
}

const createFakeSubmitEvent = () => {
  return { preventDefault: () => undefined } as unknown as FormEvent<HTMLFormElement>;
};

export function useChatComposerState({
  selectedProject,
  selectedSession,
  currentSessionId,
  provider,
  permissionMode,
  cyclePermissionMode,
  resolvePermissionModeForProvider,
  cursorModel,
  claudeModel,
  codexModel,
  currentProviderEffort,
  opencodeModel,
  isLoading,
  canAbortSession,
  tokenBudget,
  sendMessage,
  sendByCtrlEnter,
  onSessionProcessing,
  onSessionEstablished,
  onInputFocusChange,
  onFileOpen,
  onShowSettings,
  scrollToBottom,
  addMessage,
  setIsUserScrolledUp,
  setPendingPermissionRequests,
  onForkSubmitted,
}: UseChatComposerStateArgs) {
  const [input, setInput] = useState(() => {
    if (typeof window !== 'undefined' && selectedProject) {
      // Draft inputs are keyed by the DB projectId so per-project drafts
      // survive display-name changes.
      return safeLocalStorage.getItem(`draft_input_${selectedProject.projectId}`) || '';
    }
    return '';
  });
  const [isTextareaExpanded, setIsTextareaExpanded] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const handleSubmitRef = useRef<
    ((event: FormEvent<HTMLFormElement> | MouseEvent | TouchEvent | KeyboardEvent<HTMLTextAreaElement>) => Promise<void>) | null
  >(null);
  const inputValueRef = useRef(input);
  const selectedProjectId = selectedProject?.projectId;
  // Prefer the stable backend-allocated id (selectedSession.id) but fall back
  // to currentSessionId for a just-established session that hasn't been
  // handed back to the parent's `selectedSession` prop yet.
  const sessionKey = selectedSession?.id || currentSessionId || null;

  // Mirrors a new composer value into both `input` state and `inputValueRef`
  // in one call; handed to useEditSentPromptFork so it doesn't need its own
  // access to the input state it doesn't own.
  const setInputValue = useCallback((value: string) => {
    setInput(value);
    inputValueRef.current = value;
  }, [setInput]);

  const {
    editingSentPrompt,
    setEditingSentPrompt,
    lastEditSubmissionRef,
    startEditSentPrompt,
    cancelEditSentPrompt,
    restoreEditSentPrompt,
    clearEditSubmission,
  } = useEditSentPromptFork({ sessionKey, textareaRef, setInputValue });

  const {
    attachedImages,
    setAttachedImages,
    uploadingImages,
    setUploadingImages,
    imageErrors,
    setImageErrors,
    handlePaste,
    getRootProps,
    getInputProps,
    isDragActive,
    open,
  } = useComposerAttachments();

  // Mirrors a restored queued draft's text/images into the composer; built
  // from setInputValue + setAttachedImages so useMessageQueue doesn't need
  // its own access to either state it doesn't own.
  const restoreDraft = useCallback((text: string, images: File[]) => {
    setInputValue(text);
    setAttachedImages(images);
  }, [setInputValue, setAttachedImages]);

  const {
    queuedDraft,
    setQueuedDraft,
    queuedDraftSessionRef,
    editQueuedDraft,
    deleteQueuedDraft,
  } = useMessageQueue({ sessionKey, isLoading, textareaRef, handleSubmitRef, restoreDraft });

  const {
    commandModalPayload,
    closeCommandModal,
    executeCommand,
    showCostModal,
  } = useSlashDispatch({
    selectedProject,
    selectedSession,
    currentSessionId,
    provider,
    permissionMode,
    cursorModel,
    claudeModel,
    codexModel,
    opencodeModel,
    tokenBudget,
    sendMessage,
    onSessionEstablished,
    onFileOpen,
    onShowSettings,
    addMessage,
    input,
    setInputValue,
    handleSubmitRef,
    textareaRef,
    setAttachedImages,
    setUploadingImages,
    setImageErrors,
    setIsTextareaExpanded,
  });

  const {
    slashCommands,
    slashCommandsCount,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    handleCommandInputChange,
    handleCommandMenuKeyDown,
  } = useSlashCommands({
    selectedProject,
    provider,
    input,
    setInput,
    textareaRef,
  });

  const slashCommandNames = useMemo(
    () => new Set(slashCommands.map((command) => command.name)),
    [slashCommands],
  );

  const {
    showFileDropdown,
    filteredFiles,
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    setCursorPosition,
    handleFileMentionsKeyDown,
  } = useFileMentions({
    selectedProject,
    input,
    setInput,
    textareaRef,
  });

  // Kept immediately before useComposerDraft's call: pre-extraction, this
  // effect and the draft-restore effect it now precedes were declared back
  // to back (inputValueRef sync, then the project-switch restore) — same
  // relative order, preserved here rather than left at handleVoiceTranscript's
  // original position further down.
  useEffect(() => {
    inputValueRef.current = input;
  }, [input]);

  const {
    inputHighlightRef,
    handleInputChange,
    handleTextareaClick,
    handleTextareaInput,
    syncInputOverlayScroll,
    handleClearInput,
  } = useComposerDraft({
    input,
    setInput,
    inputValueRef,
    selectedProjectId,
    textareaRef,
    setIsTextareaExpanded,
    resetCommandMenuState,
    handleCommandInputChange,
    setCursorPosition,
  });

  const { handleSubmit, handleKeyDown } = useSubmitPipeline({
    session: { selectedProject, selectedSession, currentSessionId, sessionKey },
    providerSettings: {
      provider,
      cursorModel,
      claudeModel,
      codexModel,
      opencodeModel,
      currentProviderEffort,
      permissionMode,
      resolvePermissionModeForProvider,
    },
    lifecycle: {
      isLoading,
      sendMessage,
      onSessionProcessing,
      onSessionEstablished,
      onForkSubmitted,
      addMessage,
      scrollToBottom,
      setIsUserScrolledUp,
    },
    composer: { textareaRef, inputValueRef, setInput, setIsTextareaExpanded, resetCommandMenuState },
    attachments: { attachedImages, setAttachedImages, setUploadingImages, setImageErrors },
    queue: { queuedDraftSessionRef, setQueuedDraft },
    editFork: { editingSentPrompt, setEditingSentPrompt, lastEditSubmissionRef },
    slash: { slashCommands, executeCommand },
    keyNav: {
      handleCommandMenuKeyDown,
      handleFileMentionsKeyDown,
      showFileDropdown,
      showCommandMenu,
      cyclePermissionMode,
      sendByCtrlEnter,
    },
  });

  useEffect(() => {
    handleSubmitRef.current = handleSubmit;
  }, [handleSubmit]);

  // A voice transcript either fills the input (to edit before sending) or, when the
  // user tapped "stop and send", is submitted straight away. Mirror the value into
  // inputValueRef synchronously so handleSubmit reads the new text, not the stale state.
  const handleVoiceTranscript = useCallback((text: string, send?: boolean) => {
    const base = inputValueRef.current.trim();
    const next = base ? `${base} ${text}` : text;
    setInput(next);
    inputValueRef.current = next;
    if (send) handleSubmitRef.current?.(createFakeSubmitEvent());
  }, [setInput]);

  const {
    handleAbortSession,
    handleGrantToolPermission,
    handlePermissionDecision,
    isInputFocused,
    handleInputFocusChange,
  } = useComposerActions({
    canAbortSession,
    selectedSession,
    currentSessionId,
    provider,
    sendMessage,
    setPendingPermissionRequests,
    onInputFocusChange,
  });

  return {
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
    filteredFiles: filteredFiles as MentionableFile[],
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
    openImagePicker: open,
    handleSubmit,
    queuedDraft,
    editQueuedDraft,
    deleteQueuedDraft,
    editingSentPrompt,
    startEditSentPrompt,
    cancelEditSentPrompt,
    restoreEditSentPrompt,
    clearEditSubmission,
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
  };
}
