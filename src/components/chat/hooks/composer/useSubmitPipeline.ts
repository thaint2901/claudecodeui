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

const getNotificationSessionSummary = (
  selectedSession: ProjectSession | null,
  fallbackInput: string,
): string | null => {
  const sessionSummary = selectedSession?.summary || selectedSession?.name || selectedSession?.title;
  if (typeof sessionSummary === 'string' && sessionSummary.trim()) {
    const normalized = sessionSummary.replace(/\s+/g, ' ').trim();
    return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
  }

  const normalizedFallback = fallbackInput.replace(/\s+/g, ' ').trim();
  if (!normalizedFallback) {
    return null;
  }

  return normalizedFallback.length > 80 ? `${normalizedFallback.slice(0, 77)}...` : normalizedFallback;
};

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

  if (!matchedCommand || matchedCommand.type === 'skill' || matchedCommand.type === 'claude-builtin') {
    return null;
  }

  return { command: matchedCommand, dispatchInput: isHelpAlias ? '/help' : commandInput };
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
      const settingsKey =
        provider === 'cursor'
          ? 'cursor-tools-settings'
          : provider === 'codex'
            ? 'codex-settings'
            : provider === 'opencode'
                ? 'opencode-settings'
              : 'claude-settings';
      const savedSettings = safeLocalStorage.getItem(settingsKey);
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
  const model =
    provider === 'cursor'
      ? cursorModel
      : provider === 'codex'
        ? codexModel
        : provider === 'opencode'
          ? opencodeModel
          : claudeModel;

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

      // A turn is already in flight: stash this message instead of sending it.
      // It's auto-flushed (re-running this same function) once the turn ends,
      // so it still goes through slash-command interception, image upload, etc.
      if (isLoading) {
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
        // selectedProject is guaranteed by the guard at the top of handleSubmit.
        safeLocalStorage.removeItem(`draft_input_${selectedProject.projectId}`);
        // A queued draft must never carry the fork intent of the message it displaced.
        setEditingSentPrompt(null);
        return;
      }

      // Intercept slash commands only when "/" is the first input character.
      // Also accept exact "help" as a convenience alias for users who expect CLI-style help.
      const classifiedCommand = classifySlashCommand(currentInput, slashCommands);
      if (classifiedCommand) {
        executeCommand(classifiedCommand.command, classifiedCommand.dispatchInput);
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
        // A slash command is not a reply to the edited prompt — clear the fork intent.
        setEditingSentPrompt(null);
        return;
      }

      const messageContent = currentInput;

      let uploadedImages: unknown[] = [];
      if (attachedImages.length > 0) {
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
          uploadedImages = result.images;
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          console.error('Image upload failed:', error);
          addMessage({
            type: 'error',
            content: `Failed to upload images: ${message}`,
            timestamp: new Date(),
          });
          return;
        }
      }

      const resolvedProjectPath = selectedProject.fullPath || selectedProject.path || '';
      const sessionSummary = getNotificationSessionSummary(selectedSession, currentInput);

      // The conversation always has a stable backend-allocated session id
      // BEFORE the first websocket send: brand-new chats allocate one here
      // via the session gateway. There is no client-visible session-id
      // handoff later — this id stays valid for the conversation's lifetime.
      let targetSessionId = selectedSession?.id || currentSessionId || null;
      if (!targetSessionId) {
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
          targetSessionId = body?.data?.sessionId || null;
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          console.error('Session creation failed:', error);
          addMessage({
            type: 'error',
            content: `Failed to start a new session: ${message}`,
            timestamp: new Date(),
          });
          return;
        }

        if (!targetSessionId) {
          addMessage({
            type: 'error',
            content: 'Failed to start a new session: no session id returned.',
            timestamp: new Date(),
          });
          return;
        }

        onSessionEstablished?.(targetSessionId, {
          provider,
          project: selectedProject,
          summary: sessionSummary,
        });
      }

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

      // One message shape for every provider. The backend resolves the
      // provider, project path, and provider-native resume id from the
      // session row; `options` only carries composer-level preferences.
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

      if (editingSentPrompt) {
        // Hold the text until the fork is known to have taken. The composer is
        // cleared unconditionally below, and a FORK_FAILED afterwards used to
        // leave the user with nothing — their edit gone from the composer and
        // from the per-project draft, with only a console line to say why.
        lastEditSubmissionRef.current = { uuid: editingSentPrompt.uuid, content: messageContent };
        onForkSubmitted?.(editingSentPrompt.uuid);
        setEditingSentPrompt(null);
      }

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

      safeLocalStorage.removeItem(`draft_input_${selectedProject.projectId}`);
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

      if (event.key === 'Tab' && !showFileDropdown && !showCommandMenu) {
        event.preventDefault();
        cyclePermissionMode();
        return;
      }

      if (event.key === 'Enter') {
        if (event.nativeEvent.isComposing) {
          return;
        }

        if ((event.ctrlKey || event.metaKey) && !event.shiftKey) {
          event.preventDefault();
          handleSubmit(event);
        } else if (!event.shiftKey && !event.ctrlKey && !event.metaKey && !sendByCtrlEnter) {
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
