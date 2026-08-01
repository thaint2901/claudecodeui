import { useCallback } from 'react';
import type {
  Dispatch,
  FormEvent,
  KeyboardEvent,
  MouseEvent,
  MutableRefObject,
  RefObject,
  SetStateAction,
  TouchEvent,
} from 'react';

import { authenticatedFetch } from '../../../../utils/api';
import type { MarkSessionProcessing } from '../../../../hooks/useSessionProtection';
import { safeLocalStorage, type QueuedSendOptions } from '../../utils/chatStorage';
import type { ChatMessage, PermissionMode, SessionEstablishedContext } from '../../types/types';
import type { Project, ProjectSession, LLMProvider } from '../../../../types/app';
import type { SlashCommand } from '../useSlashCommands';

import type { QueuedDraft } from './useMessageQueue';
import type { EditingSentPrompt, LastEditSubmission } from './useEditSentPromptFork';

/** Truncates already-normalized notification text to the same 80-char budget used everywhere below. */
const truncateForNotification = (text: string): string =>
  text.length > 80 ? `${text.slice(0, 77)}...` : text;

/** The session's own display text, if it has one — checked in this precedence order. */
const resolveRawSessionSummary = (selectedSession: ProjectSession | null): string | undefined =>
  selectedSession?.summary || selectedSession?.name || selectedSession?.title;

const getNotificationSessionSummary = (
  selectedSession: ProjectSession | null,
  fallbackInput: string,
): string | null => {
  const sessionSummary = resolveRawSessionSummary(selectedSession);
  if (typeof sessionSummary === 'string' && sessionSummary.trim()) {
    return truncateForNotification(sessionSummary.replace(/\s+/g, ' ').trim());
  }

  const normalizedFallback = fallbackInput.replace(/\s+/g, ' ').trim();
  if (!normalizedFallback) {
    return null;
  }

  return truncateForNotification(normalizedFallback);
};

/** States the exclusion question the old inline `if` at this seam was really asking. */
const isCommandExcludedFromDispatch = (command: SlashCommand | undefined): boolean =>
  !command || command.type === 'skill' || command.type === 'claude-builtin';

/**
 * Pure characterization of handleSubmit's slash-command classification block
 * (the "is this input a slash command" decision the Task 3 ledger placed in
 * concern E, not concern C): given the raw composer text and the loaded
 * command list, decide whether this send should be intercepted as a slash
 * command instead of a normal chat send. Same matching rules as the
 * pre-extraction inline block (help alias, name-prefix match, the synthetic
 * `/help` fallback, and the skill/claude-builtin exclusion) — no behavior
 * change. Returns null when the input should fall through to a normal send.
 */
export function classifySlashCommand(
  currentInput: string,
  slashCommands: SlashCommand[],
): { command: SlashCommand; dispatchInput: string } | null {
  const commandInput = currentInput.trimEnd();
  const isHelpAlias = commandInput.trim().toLowerCase() === 'help';
  if (!commandInput.startsWith('/') && !isHelpAlias) {
    return null;
  }

  const firstSpace = commandInput.indexOf(' ');
  const commandName = isHelpAlias
    ? '/help'
    : firstSpace > 0 ? commandInput.slice(0, firstSpace) : commandInput;
  const matchedCommand =
    slashCommands.find((cmd) => cmd.name === commandName) ||
    (commandName === '/help'
      ? ({
          name: '/help',
          description: 'Show help documentation for Claude Code',
          namespace: 'ccui',
          metadata: { type: 'ccui' },
        } as SlashCommand)
      : undefined);

  if (isCommandExcludedFromDispatch(matchedCommand)) {
    return null;
  }

  return { command: matchedCommand as SlashCommand, dispatchInput: isHelpAlias ? '/help' : commandInput };
}

export interface ComputeSendOptionsArgs {
  provider: LLMProvider;
  cursorModel: string;
  claudeModel: string;
  codexModel: string;
  opencodeModel: string;
  currentProviderEffort: string;
  permissionMode: PermissionMode | string;
  resolvePermissionModeForProvider: (provider: LLMProvider, requestedMode: PermissionMode | string) => PermissionMode;
  selectedSession: ProjectSession | null;
  currentInput: string;
  /**
   * The composer's active edit-fork state, if any. Pass null (not the live
   * value) at a call site that must never carry fork intent — the queued-
   * draft path does this deliberately, mirroring the pre-extraction comment
   * "a queued draft must never carry the fork intent of the message it
   * displaced".
   */
  editingSentPrompt: EditingSentPrompt | null;
}

/** Which per-provider localStorage key holds the saved tools settings. */
const resolveToolsSettingsKey = (provider: LLMProvider): string => {
  if (provider === 'cursor') {
    return 'cursor-tools-settings';
  }
  if (provider === 'codex') {
    return 'codex-settings';
  }
  if (provider === 'opencode') {
    return 'opencode-settings';
  }
  return 'claude-settings';
};

/** Which model string applies for the active provider. */
const resolveModelForProvider = (
  provider: LLMProvider,
  cursorModel: string,
  claudeModel: string,
  codexModel: string,
  opencodeModel: string,
): string => {
  if (provider === 'cursor') {
    return cursorModel;
  }
  if (provider === 'codex') {
    return codexModel;
  }
  if (provider === 'opencode') {
    return opencodeModel;
  }
  return claudeModel;
};

/**
 * Pure characterization of buildSendOptions's body (the useCallback of that
 * name in useChatComposerState.ts before extraction) PLUS the
 * `editAtMessageUuid` merge that used to happen inline at handleSubmit's
 * `sendMessage` call site (`...(editingSentPrompt ? { editAtMessageUuid:
 * editingSentPrompt.uuid } : {})`). Folding that merge in here means callers
 * no longer need to remember to attach the fork field themselves.
 */
export function computeSendOptions({
  provider,
  cursorModel,
  claudeModel,
  codexModel,
  opencodeModel,
  currentProviderEffort,
  permissionMode,
  resolvePermissionModeForProvider,
  selectedSession,
  currentInput,
  editingSentPrompt,
}: ComputeSendOptionsArgs): QueuedSendOptions {
  const getToolsSettings = () => {
    try {
      const savedSettings = safeLocalStorage.getItem(resolveToolsSettingsKey(provider));
      if (savedSettings) {
        return JSON.parse(savedSettings);
      }
    } catch (error) {
      console.error('Error loading tools settings:', error);
    }

    return {
      allowedTools: [],
      disallowedTools: [],
      skipPermissions: false,
    };
  };

  const toolsSettings = getToolsSettings();
  const model = resolveModelForProvider(provider, cursorModel, claudeModel, codexModel, opencodeModel);

  return {
    model,
    effort: currentProviderEffort,
    permissionMode: resolvePermissionModeForProvider(provider, permissionMode),
    toolsSettings,
    skipPermissions: toolsSettings?.skipPermissions || false,
    sessionSummary: getNotificationSessionSummary(selectedSession, currentInput),
    ...(editingSentPrompt ? { editAtMessageUuid: editingSentPrompt.uuid } : {}),
  };
}

/**
 * Extracted step: handleSubmit's image-upload step. Uploads any attached
 * images and reports a failure through `addMessage` exactly as the old
 * inline try/catch did (same log line, same error-message payload). No
 * attachments is a no-op success with an empty image list.
 */
async function uploadAttachedImages(
  attachedImages: File[],
  addMessage: (msg: ChatMessage) => void,
): Promise<{ ok: true; images: unknown[] } | { ok: false }> {
  if (attachedImages.length === 0) {
    return { ok: true, images: [] };
  }

  const formData = new FormData();
  attachedImages.forEach((file) => {
    formData.append('images', file);
  });

  try {
    const response = await authenticatedFetch('/api/assets/images', {
      method: 'POST',
      headers: {},
      body: formData,
    });

    if (!response.ok) {
      throw new Error('Failed to upload images');
    }

    const result = await response.json();
    return { ok: true, images: result.images };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('Image upload failed:', error);
    addMessage({
      type: 'error',
      content: `Failed to upload images: ${message}`,
      timestamp: new Date(),
    });
    return { ok: false };
  }
}

interface ResolveTargetSessionIdArgs {
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  provider: LLMProvider;
  selectedProject: Project;
  sessionSummary: string | null;
  onSessionEstablished?: (sessionId: string, context: SessionEstablishedContext) => void;
  addMessage: (msg: ChatMessage) => void;
}

/**
 * Extracted step: handleSubmit's session-id resolution step. The
 * conversation always has a stable backend-allocated session id BEFORE the
 * first websocket send — brand-new chats allocate one here via the session
 * gateway. There is no client-visible session-id handoff later — this id
 * stays valid for the conversation's lifetime. Returns null (after reporting
 * the failure through `addMessage`, same payloads as before) when no session
 * id could be resolved.
 */
async function resolveTargetSessionId({
  selectedSession,
  currentSessionId,
  provider,
  selectedProject,
  sessionSummary,
  onSessionEstablished,
  addMessage,
}: ResolveTargetSessionIdArgs): Promise<string | null> {
  const existingSessionId = selectedSession?.id || currentSessionId || null;
  if (existingSessionId) {
    return existingSessionId;
  }

  const resolvedProjectPath = selectedProject.fullPath || selectedProject.path || '';
  let createdSessionId: string | null = null;
  try {
    const response = await authenticatedFetch('/api/providers/sessions', {
      method: 'POST',
      body: JSON.stringify({
        provider,
        projectPath: resolvedProjectPath,
      }),
    });
    if (!response.ok) {
      throw new Error(`Failed to create session (${response.status})`);
    }
    const body = await response.json();
    createdSessionId = body?.data?.sessionId || null;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('Session creation failed:', error);
    addMessage({
      type: 'error',
      content: `Failed to start a new session: ${message}`,
      timestamp: new Date(),
    });
    return null;
  }

  if (!createdSessionId) {
    addMessage({
      type: 'error',
      content: 'Failed to start a new session: no session id returned.',
      timestamp: new Date(),
    });
    return null;
  }

  onSessionEstablished?.(createdSessionId, {
    provider,
    project: selectedProject,
    summary: sessionSummary,
  });

  return createdSessionId;
}

type SubmitEvent = FormEvent<HTMLFormElement> | MouseEvent | TouchEvent | KeyboardEvent<HTMLTextAreaElement>;

interface SubmitPipelineSessionParams {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  /** Prefers selectedSession.id, falling back to currentSessionId; owned by the orchestrator. */
  sessionKey: string | null;
}

interface SubmitPipelineProviderParams {
  provider: LLMProvider;
  cursorModel: string;
  claudeModel: string;
  codexModel: string;
  opencodeModel: string;
  currentProviderEffort: string;
  permissionMode: PermissionMode | string;
  resolvePermissionModeForProvider: (provider: LLMProvider, requestedMode: PermissionMode | string) => PermissionMode;
}

interface SubmitPipelineLifecycleParams {
  isLoading: boolean;
  sendMessage: (message: unknown) => void;
  onSessionProcessing?: MarkSessionProcessing;
  onSessionEstablished?: (sessionId: string, context: SessionEstablishedContext) => void;
  onForkSubmitted?: (uuid: string) => void;
  addMessage: (msg: ChatMessage) => void;
  scrollToBottom: () => void;
  setIsUserScrolledUp: (isScrolledUp: boolean) => void;
}

interface SubmitPipelineComposerParams {
  textareaRef: RefObject<HTMLTextAreaElement>;
  inputValueRef: MutableRefObject<string>;
  setInput: Dispatch<SetStateAction<string>>;
  setIsTextareaExpanded: Dispatch<SetStateAction<boolean>>;
  resetCommandMenuState: () => void;
}

interface SubmitPipelineAttachmentsParams {
  attachedImages: File[];
  setAttachedImages: Dispatch<SetStateAction<File[]>>;
  setUploadingImages: Dispatch<SetStateAction<Map<string, number>>>;
  setImageErrors: Dispatch<SetStateAction<Map<string, string>>>;
}

interface SubmitPipelineQueueParams {
  queuedDraftSessionRef: MutableRefObject<string | null>;
  setQueuedDraft: Dispatch<SetStateAction<QueuedDraft | null>>;
}

interface SubmitPipelineEditForkParams {
  editingSentPrompt: EditingSentPrompt | null;
  setEditingSentPrompt: Dispatch<SetStateAction<EditingSentPrompt | null>>;
  lastEditSubmissionRef: MutableRefObject<LastEditSubmission | null>;
}

interface SubmitPipelineSlashParams {
  slashCommands: SlashCommand[];
  executeCommand: (
    command: SlashCommand,
    rawInput?: string,
    options?: { preserveInput?: boolean },
  ) => Promise<void>;
}

interface SubmitPipelineKeyNavParams {
  handleCommandMenuKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  handleFileMentionsKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  showFileDropdown: boolean;
  showCommandMenu: boolean;
  cyclePermissionMode: () => void;
  sendByCtrlEnter?: boolean;
}

/**
 * Grouped rather than flat: handleSubmit is the coupling core of the composer
 * split (six concerns converge on it), and a flat parameter list would run
 * past 40 entries. Each group mirrors one sibling hook's API surface (or the
 * orchestrator's own local state) so a reviewer can trace a group back to
 * where it is produced.
 */
interface UseSubmitPipelineParams {
  session: SubmitPipelineSessionParams;
  providerSettings: SubmitPipelineProviderParams;
  lifecycle: SubmitPipelineLifecycleParams;
  composer: SubmitPipelineComposerParams;
  attachments: SubmitPipelineAttachmentsParams;
  queue: SubmitPipelineQueueParams;
  editFork: SubmitPipelineEditForkParams;
  slash: SubmitPipelineSlashParams;
  keyNav: SubmitPipelineKeyNavParams;
}

export interface SubmitPipelineApi {
  handleSubmit: (event: SubmitEvent) => Promise<void>;
  handleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
}

/** The Tab shortcut cycles permission mode only when neither dropdown is showing. */
const isPermissionModeCycleShortcut = (
  event: KeyboardEvent<HTMLTextAreaElement>,
  showFileDropdown: boolean,
  showCommandMenu: boolean,
): boolean => event.key === 'Tab' && !showFileDropdown && !showCommandMenu;

/** Ctrl/Cmd+Enter (without Shift) always submits, regardless of the ctrl-to-send preference. */
const isSubmitViaCtrlOrCmdEnter = (event: KeyboardEvent<HTMLTextAreaElement>): boolean =>
  (event.ctrlKey || event.metaKey) && !event.shiftKey;

/** Plain Enter submits only when the user hasn't opted into ctrl-to-send. */
const isSubmitViaPlainEnter = (
  event: KeyboardEvent<HTMLTextAreaElement>,
  sendByCtrlEnter: boolean | undefined,
): boolean => !event.shiftKey && !event.ctrlKey && !event.metaKey && !sendByCtrlEnter;

export function useSubmitPipeline({
  session,
  providerSettings,
  lifecycle,
  composer,
  attachments,
  queue,
  editFork,
  slash,
  keyNav,
}: UseSubmitPipelineParams): SubmitPipelineApi {
  const { selectedProject, selectedSession, currentSessionId, sessionKey } = session;
  const {
    provider,
    cursorModel,
    claudeModel,
    codexModel,
    opencodeModel,
    currentProviderEffort,
    permissionMode,
    resolvePermissionModeForProvider,
  } = providerSettings;
  const {
    isLoading,
    sendMessage,
    onSessionProcessing,
    onSessionEstablished,
    onForkSubmitted,
    addMessage,
    scrollToBottom,
    setIsUserScrolledUp,
  } = lifecycle;
  const { textareaRef, inputValueRef, setInput, setIsTextareaExpanded, resetCommandMenuState } = composer;
  const { attachedImages, setAttachedImages, setUploadingImages, setImageErrors } = attachments;
  const { queuedDraftSessionRef, setQueuedDraft } = queue;
  const { editingSentPrompt, setEditingSentPrompt, lastEditSubmissionRef } = editFork;
  const { slashCommands, executeCommand } = slash;
  const {
    handleCommandMenuKeyDown,
    handleFileMentionsKeyDown,
    showFileDropdown,
    showCommandMenu,
    cyclePermissionMode,
    sendByCtrlEnter,
  } = keyNav;

  const handleSubmit = useCallback(
    async (event: SubmitEvent) => {
      event.preventDefault();
      const currentInput = inputValueRef.current;
      if (!currentInput.trim() || !selectedProject) {
        return;
      }
      // Narrowed once so the nested step functions below don't have to
      // re-prove selectedProject is non-null (TS narrowing doesn't cross
      // into nested function closures).
      const activeProject = selectedProject;

      // Same statement order/shape shared by the queue-when-loading and
      // slash-interception steps below — both clear the composer the same way.
      const clearComposerAfterQueueOrSlash = () => {
        setInput('');
        inputValueRef.current = '';
        setAttachedImages([]);
        setUploadingImages(new Map());
        setImageErrors(new Map());
        resetCommandMenuState();
        setIsTextareaExpanded(false);
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto';
        }
      };

      // A turn is already in flight: stash this message instead of sending it.
      // It's auto-flushed (re-running this same function) once the turn ends,
      // so it still goes through slash-command interception, image upload, etc.
      if (isLoading) {
        const queueDraftForInFlightTurn = () => {
          queuedDraftSessionRef.current = sessionKey;
          setQueuedDraft({
            content: currentInput,
            images: attachedImages,
            options: computeSendOptions({
              provider,
              cursorModel,
              claudeModel,
              codexModel,
              opencodeModel,
              currentProviderEffort,
              permissionMode,
              resolvePermissionModeForProvider,
              selectedSession,
              currentInput,
              // A queued draft must never carry the fork intent of the message it displaced.
              editingSentPrompt: null,
            }),
          });
          clearComposerAfterQueueOrSlash();
          safeLocalStorage.removeItem(`draft_input_${activeProject.projectId}`);
          // A queued draft must never carry the fork intent of the message it displaced.
          setEditingSentPrompt(null);
        };

        queueDraftForInFlightTurn();
        return;
      }

      // Intercept slash commands only when "/" is the first input character.
      // Also accept exact "help" as a convenience alias for users who expect CLI-style help.
      const classifiedCommand = classifySlashCommand(currentInput, slashCommands);
      if (classifiedCommand) {
        const dispatchSlashCommand = () => {
          executeCommand(classifiedCommand.command, classifiedCommand.dispatchInput);
          clearComposerAfterQueueOrSlash();
          // A slash command is not a reply to the edited prompt — clear the fork intent.
          setEditingSentPrompt(null);
        };

        dispatchSlashCommand();
        return;
      }

      const messageContent = currentInput;

      const uploadResult = await uploadAttachedImages(attachedImages, addMessage);
      if (!uploadResult.ok) {
        return;
      }
      const uploadedImages = uploadResult.images;

      const sessionSummary = getNotificationSessionSummary(selectedSession, currentInput);

      const targetSessionId = await resolveTargetSessionId({
        selectedSession,
        currentSessionId,
        provider,
        selectedProject: activeProject,
        sessionSummary,
        onSessionEstablished,
        addMessage,
      });
      if (!targetSessionId) {
        return;
      }

      // One message shape for every provider. The backend resolves the
      // provider, project path, and provider-native resume id from the
      // session row; `options` only carries composer-level preferences.
      const dispatchChatSend = () => {
        const userMessage: ChatMessage = {
          type: 'user',
          content: currentInput,
          images: uploadedImages as any,
          timestamp: new Date(),
        };

        addMessage(userMessage);
        // Mark this request as processing in the per-session activity map (the
        // single source of truth the indicator derives from). The id is always
        // concrete at this point — no pending placeholder exists anymore.
        onSessionProcessing?.(targetSessionId, {
          statusText: null,
          canInterrupt: true,
        });

        setIsUserScrolledUp(false);
        setTimeout(() => scrollToBottom(), 100);

        sendMessage({
          type: 'chat.send',
          sessionId: targetSessionId,
          content: messageContent,
          options: {
            ...computeSendOptions({
              provider,
              cursorModel,
              claudeModel,
              codexModel,
              opencodeModel,
              currentProviderEffort,
              permissionMode,
              resolvePermissionModeForProvider,
              selectedSession,
              currentInput: messageContent,
              editingSentPrompt,
            }),
            images: uploadedImages,
          },
        });
      };
      dispatchChatSend();

      // Hold the text until the fork is known to have taken. The composer is
      // cleared unconditionally below, and a FORK_FAILED afterwards used to
      // leave the user with nothing — their edit gone from the composer and
      // from the per-project draft, with only a console line to say why.
      const recordEditForkSubmissionIfPending = () => {
        if (editingSentPrompt) {
          lastEditSubmissionRef.current = { uuid: editingSentPrompt.uuid, content: messageContent };
          onForkSubmitted?.(editingSentPrompt.uuid);
          setEditingSentPrompt(null);
        }
      };
      recordEditForkSubmissionIfPending();

      const clearComposerAfterSend = () => {
        setInput('');
        inputValueRef.current = '';
        resetCommandMenuState();
        setAttachedImages([]);
        setUploadingImages(new Map());
        setImageErrors(new Map());
        setIsTextareaExpanded(false);

        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto';
        }

        safeLocalStorage.removeItem(`draft_input_${activeProject.projectId}`);
      };
      clearComposerAfterSend();
    },
    [
      selectedSession,
      attachedImages,
      currentSessionId,
      executeCommand,
      isLoading,
      onSessionProcessing,
      onSessionEstablished,
      provider,
      resetCommandMenuState,
      scrollToBottom,
      selectedProject,
      sendMessage,
      sessionKey,
      addMessage,
      setIsUserScrolledUp,
      slashCommands,
      editingSentPrompt,
      lastEditSubmissionRef,
      setEditingSentPrompt,
      onForkSubmitted,
      setAttachedImages,
      setUploadingImages,
      setImageErrors,
      queuedDraftSessionRef,
      setQueuedDraft,
      cursorModel,
      claudeModel,
      codexModel,
      currentProviderEffort,
      opencodeModel,
      permissionMode,
      resolvePermissionModeForProvider,
      inputValueRef,
      setInput,
      setIsTextareaExpanded,
      textareaRef,
    ],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (handleCommandMenuKeyDown(event)) {
        return;
      }

      if (handleFileMentionsKeyDown(event)) {
        return;
      }

      if (isPermissionModeCycleShortcut(event, showFileDropdown, showCommandMenu)) {
        event.preventDefault();
        cyclePermissionMode();
        return;
      }

      if (event.key === 'Enter') {
        if (event.nativeEvent.isComposing) {
          return;
        }

        if (isSubmitViaCtrlOrCmdEnter(event)) {
          event.preventDefault();
          handleSubmit(event);
        } else if (isSubmitViaPlainEnter(event, sendByCtrlEnter)) {
          event.preventDefault();
          handleSubmit(event);
        }
      }
    },
    [
      cyclePermissionMode,
      handleCommandMenuKeyDown,
      handleFileMentionsKeyDown,
      handleSubmit,
      sendByCtrlEnter,
      showCommandMenu,
      showFileDropdown,
    ],
  );

  return { handleSubmit, handleKeyDown };
}
