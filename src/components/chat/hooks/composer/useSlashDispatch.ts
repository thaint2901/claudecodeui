import { useCallback, useState } from 'react';
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
import { safeLocalStorage } from '../../utils/chatStorage';
import { escapeRegExp } from '../../utils/chatFormatting';
import type { ChatMessage, PermissionMode, SessionEstablishedContext } from '../../types/types';
import type { Project, ProjectSession, LLMProvider, ProviderModelsCacheInfo } from '../../../../types/app';
import type { SlashCommand } from '../useSlashCommands';

interface CommandExecutionResult {
  type: 'builtin' | 'custom';
  action?: string;
  data?: any;
  // Legacy field: the expanded command body. Kept for back-compat with any
  // older server that still parses the .md file. New servers return
  // `injectAsPrompt` (the slash form) instead, and the active session's
  // runtime dispatcher reads the file itself.
  content?: string;
  injectAsPrompt?: string;
  hasBashCommands?: boolean;
  hasFileIncludes?: boolean;
}

export type ModelCommandData = {
  current?: {
    provider?: string;
    providerLabel?: string;
    model?: string;
  };
  available?: Partial<Record<LLMProvider, string[]>>;
  availableModels?: string[];
  availableOptions?: Array<{
    value: string;
    label?: string;
    description?: string;
  }>;
  defaultModel?: string;
  cache?: ProviderModelsCacheInfo;
};

export type CostCommandData = {
  tokenUsage?: {
    used?: number;
    total?: number;
  };
  tokenBreakdown?: {
    input?: number;
    output?: number;
  };
  provider?: string;
  model?: string;
};

export type StatusCommandData = {
  version?: string;
  packageName?: string;
  uptime?: string;
  model?: string;
  provider?: string;
  nodeVersion?: string;
  platform?: string;
  pid?: number;
  memoryUsage?: {
    rssMb?: number;
    heapUsedMb?: number;
    heapTotalMb?: number;
  };
};

export type HelpCommandData = {
  content?: string;
  format?: string;
  commands?: Array<{
    name: string;
    description?: string;
    namespace?: string;
  }>;
};

export type CommandModalKind = 'help' | 'models' | 'cost' | 'status';

export type CommandModalPayload = {
  kind: CommandModalKind;
  data: HelpCommandData | ModelCommandData | CostCommandData | StatusCommandData;
};

const createFakeSubmitEvent = () => {
  return { preventDefault: () => undefined } as unknown as FormEvent<HTMLFormElement>;
};

/**
 * Pure characterization of executeCommand's actual decision: given the raw
 * composer text and the already-matched command's name, split whatever
 * follows the name into whitespace-separated tokens. Same regex/logic as the
 * pre-extraction inline expression — no behavior change.
 */
export function parseCommandArgs(effectiveInput: string, commandName: string): string[] {
  const commandMatch = effectiveInput.match(new RegExp(`${escapeRegExp(commandName)}\\s*(.*)`));
  return commandMatch && commandMatch[1] ? commandMatch[1].trim().split(/\s+/) : [];
}

interface UseSlashDispatchParams {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  provider: LLMProvider;
  permissionMode: PermissionMode | string;
  cursorModel: string;
  claudeModel: string;
  codexModel: string;
  opencodeModel: string;
  tokenBudget: Record<string, unknown> | null;
  sendMessage: (message: unknown) => void;
  onSessionEstablished?: (sessionId: string, context: SessionEstablishedContext) => void;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  addMessage: (msg: ChatMessage) => void;
  /** Current composer text; used as executeCommand's fallback when no rawInput is given. */
  input: string;
  /** Mirrors a new composer value into both `input` state and `inputValueRef`; owned by the orchestrator. */
  setInputValue: (value: string) => void;
  handleSubmitRef: MutableRefObject<
    ((event: FormEvent<HTMLFormElement> | MouseEvent | TouchEvent | KeyboardEvent<HTMLTextAreaElement>) => Promise<void>) | null
  >;
  textareaRef: RefObject<HTMLTextAreaElement>;
  setAttachedImages: Dispatch<SetStateAction<File[]>>;
  setUploadingImages: Dispatch<SetStateAction<Map<string, number>>>;
  setImageErrors: Dispatch<SetStateAction<Map<string, string>>>;
  setIsTextareaExpanded: Dispatch<SetStateAction<boolean>>;
}

export interface SlashDispatchApi {
  commandModalPayload: CommandModalPayload | null;
  closeCommandModal: () => void;
  executeCommand: (
    command: SlashCommand,
    rawInput?: string,
    options?: { preserveInput?: boolean },
  ) => Promise<void>;
  showCostModal: () => void;
}

export function useSlashDispatch({
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
}: UseSlashDispatchParams): SlashDispatchApi {
  const [commandModalPayload, setCommandModalPayload] = useState<CommandModalPayload | null>(null);

  const handleBuiltInCommand = useCallback(
    (result: CommandExecutionResult) => {
      const { action, data } = result;
      switch (action) {
        case 'help':
          setCommandModalPayload({
            kind: 'help',
            data: (data || {}) as HelpCommandData,
          });
          break;

        case 'models':
          setCommandModalPayload({
            kind: 'models',
            data: (data || {}) as ModelCommandData,
          });
          break;

        case 'cost': {
          setCommandModalPayload({
            kind: 'cost',
            data: (data || {}) as CostCommandData,
          });
          break;
        }

        case 'status': {
          setCommandModalPayload({
            kind: 'status',
            data: (data || {}) as StatusCommandData,
          });
          break;
        }

        case 'memory':
          if (data.error) {
            addMessage({
              type: 'assistant',
              content: `Warning: ${data.message}`,
              timestamp: Date.now(),
            });
          } else {
            addMessage({
              type: 'assistant',
              content: `${data.message}\n\nPath: \`${data.path}\``,
              timestamp: Date.now(),
            });
            if (data.exists && onFileOpen) {
              onFileOpen(data.path);
            }
          }
          break;

        case 'config':
          onShowSettings?.();
          break;

        default:
          console.warn('Unknown built-in command action:', action);
      }
    },
    [onFileOpen, onShowSettings, addMessage],
  );

  const closeCommandModal = useCallback(() => {
    setCommandModalPayload(null);
  }, []);

  const handleCustomCommand = useCallback(async (result: CommandExecutionResult) => {
    // New servers return `injectAsPrompt` (the slash form `/cmd args`) and let
    // the active session's runtime dispatcher read the .md file itself — so
    // cloudcli never parses the body and never strips frontmatter like
    // `allowed-tools`/`model`. Fall back to the legacy `content` body only if an
    // older server returns it.
    const commandContent = result.injectAsPrompt ?? result.content ?? '';

    if (!commandContent || !selectedProject) {
      return;
    }

    // The slash form (`/cmd args`) must NOT round-trip through `handleSubmit`:
    // `handleSubmit` intercepts any input starting with `/` and re-routes it
    // through `executeCommand`, which would loop forever calling the server
    // instead of dispatching. Send the chat.send envelope directly, mirroring
    // the normal submit path (including the session allocation step that
    // `handleSubmit` performs before its WebSocket send).
    if (commandContent.startsWith('/')) {
      const resolvedProjectPath = selectedProject.fullPath || selectedProject.path || '';
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
            timestamp: Date.now(),
          });
          return;
        }

        if (!targetSessionId) {
          addMessage({
            type: 'error',
            content: 'Failed to start a new session: no session id returned.',
            timestamp: Date.now(),
          });
          return;
        }

        onSessionEstablished?.(targetSessionId, {
          provider,
          project: selectedProject,
          summary: null,
        });
      }

      // Read the per-provider tools settings so slash commands honor the
      // user's allow/deny lists and the skip-permissions toggle — same
      // logic as the normal handleSubmit path. The key shape mirrors
      // getToolsSettings() inside computeSendOptions in useSubmitPipeline.ts.
      const settingsKey =
        provider === 'cursor'
          ? 'cursor-tools-settings'
          : provider === 'codex'
            ? 'codex-settings'
            : provider === 'opencode'
              ? 'opencode-settings'
              : 'claude-settings';
      let toolsSettings: { allowedTools: unknown[]; disallowedTools: unknown[]; skipPermissions: boolean } = {
        allowedTools: [],
        disallowedTools: [],
        skipPermissions: false,
      };
      try {
        const saved = safeLocalStorage.getItem(settingsKey);
        if (saved) {
          const parsed = JSON.parse(saved);
          if (parsed && typeof parsed === 'object') {
            toolsSettings = {
              allowedTools: Array.isArray(parsed.allowedTools) ? parsed.allowedTools : [],
              disallowedTools: Array.isArray(parsed.disallowedTools) ? parsed.disallowedTools : [],
              skipPermissions: Boolean(parsed.skipPermissions),
            };
          }
        }
      } catch (error) {
        console.error('Error loading tools settings for command dispatch:', error);
      }

      sendMessage({
        type: 'chat.send',
        sessionId: targetSessionId,
        content: commandContent,
        options: {
          model: provider === 'cursor'
            ? cursorModel
            : provider === 'codex'
              ? codexModel
              : provider === 'opencode'
                ? opencodeModel
                : claudeModel,
          permissionMode,
          toolsSettings,
          skipPermissions: toolsSettings.skipPermissions,
          sessionSummary: null,
          images: [],
        },
      });
    } else {
      // Legacy body path: feed it through the composer and submit normally.
      setInputValue(commandContent);
      setTimeout(() => {
        if (handleSubmitRef.current) {
          handleSubmitRef.current(createFakeSubmitEvent());
        }
      }, 0);
    }

    // Always clear the composer + transient state after dispatch, mirroring
    // what `handleSubmit` does for a normal send. `resetCommandMenuState` is
    // omitted intentionally: the orchestrator (useChatComposerState) calls
    // useSlashDispatch before it calls useSlashCommands, so
    // resetCommandMenuState doesn't exist yet at this hook's call site and
    // can't be passed in as a param. The command menu closes naturally once
    // the input is empty.
    setInputValue('');
    setAttachedImages([]);
    setUploadingImages(new Map());
    setImageErrors(new Map());
    setIsTextareaExpanded(false);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
    safeLocalStorage.removeItem(`draft_input_${selectedProject.projectId}`);
  }, [
    addMessage,
    claudeModel,
    codexModel,
    currentSessionId,
    cursorModel,
    onSessionEstablished,
    opencodeModel,
    permissionMode,
    provider,
    selectedProject,
    selectedSession,
    sendMessage,
    setInputValue,
    handleSubmitRef,
    textareaRef,
    setAttachedImages,
    setUploadingImages,
    setImageErrors,
    setIsTextareaExpanded,
  ]);

  const executeCommand = useCallback(
    async (command: SlashCommand, rawInput?: string, options?: { preserveInput?: boolean }) => {
      if (!command || !selectedProject) {
        return;
      }

      try {
        const effectiveInput = rawInput ?? input;
        const args = parseCommandArgs(effectiveInput, command.name);

        // The `/api/commands/execute` context sends `projectId` now instead of
        // a folder-derived project name; the path is still included verbatim.
        const context = {
          projectPath: selectedProject.fullPath || selectedProject.path,
          projectId: selectedProject.projectId,
          sessionId: currentSessionId,
          provider,
          model: provider === 'cursor'
            ? cursorModel
            : provider === 'codex'
              ? codexModel
              : provider === 'opencode'
                  ? opencodeModel
                  : claudeModel,
          tokenUsage: tokenBudget,
        };

        const response = await authenticatedFetch('/api/commands/execute', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            commandName: command.name,
            commandPath: command.path,
            args,
            context,
          }),
        });

        if (!response.ok) {
          let errorMessage = `Failed to execute command (${response.status})`;
          try {
            const errorData = await response.json();
            errorMessage = errorData?.message || errorData?.error || errorMessage;
          } catch {
            // Ignore JSON parse failures and use fallback message.
          }
          throw new Error(errorMessage);
        }

        const result = (await response.json()) as CommandExecutionResult;
        if (result.type === 'builtin') {
          handleBuiltInCommand(result);
          if (!options?.preserveInput) {
            setInputValue('');
          }
        } else if (result.type === 'custom') {
          await handleCustomCommand(result);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error('Error executing command:', error);
        addMessage({
          type: 'assistant',
          content: `Error executing command: ${message}`,
          timestamp: Date.now(),
        });
      }
    },
    [
      claudeModel,
      codexModel,
      currentSessionId,
      cursorModel,
      opencodeModel,
      handleBuiltInCommand,
      handleCustomCommand,
      input,
      provider,
      selectedProject,
      addMessage,
      tokenBudget,
      setInputValue,
    ],
  );

  const showCostModal = useCallback(() => {
    executeCommand(
      {
        name: '/cost',
        description: 'Display token usage information',
        namespace: 'ccui',
        metadata: { type: 'ccui' },
      } as SlashCommand,
      '/cost',
      { preserveInput: true },
    );
  }, [executeCommand]);

  return {
    commandModalPayload,
    closeCommandModal,
    executeCommand,
    showCostModal,
  };
}
