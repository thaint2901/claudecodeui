import { useCallback, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import { grantClaudeToolPermission } from '../../utils/chatPermissions';
import type { PendingPermissionRequest, PermissionGrantResult } from '../../types/types';
import type { ProjectSession, LLMProvider } from '../../../../types/app';

interface UseComposerActionsParams {
  canAbortSession: boolean;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  provider: LLMProvider;
  sendMessage: (message: unknown) => void;
  setPendingPermissionRequests: Dispatch<SetStateAction<PendingPermissionRequest[]>>;
  onInputFocusChange?: (focused: boolean) => void;
}

export interface ComposerActionsApi {
  handleAbortSession: () => void;
  handleGrantToolPermission: (suggestion: { entry: string; toolName: string }) => PermissionGrantResult;
  handlePermissionDecision: (
    requestIds: string | string[],
    decision: { allow?: boolean; message?: string; rememberEntry?: string | null; updatedInput?: unknown },
  ) => void;
  isInputFocused: boolean;
  handleInputFocusChange: (focused: boolean) => void;
}

export function useComposerActions({
  canAbortSession,
  selectedSession,
  currentSessionId,
  provider,
  sendMessage,
  setPendingPermissionRequests,
  onInputFocusChange,
}: UseComposerActionsParams): ComposerActionsApi {
  const handleAbortSession = useCallback(() => {
    if (!canAbortSession) {
      return;
    }

    const targetSessionId = selectedSession?.id || currentSessionId || null;
    if (!targetSessionId) {
      console.warn('Abort requested but no session ID is available.');
      return;
    }

    // The backend resolves the provider from the session row, so no provider
    // field is needed here.
    sendMessage({
      type: 'chat.abort',
      sessionId: targetSessionId,
    });
  }, [canAbortSession, currentSessionId, selectedSession?.id, sendMessage]);

  const handleGrantToolPermission = useCallback(
    (suggestion: { entry: string; toolName: string }) => {
      if (!suggestion || provider !== 'claude') {
        return { success: false };
      }
      return grantClaudeToolPermission(suggestion.entry);
    },
    [provider],
  );

  const handlePermissionDecision = useCallback(
    (
      requestIds: string | string[],
      decision: { allow?: boolean; message?: string; rememberEntry?: string | null; updatedInput?: unknown },
    ) => {
      const ids = Array.isArray(requestIds) ? requestIds : [requestIds];
      const validIds = ids.filter(Boolean);
      if (validIds.length === 0) {
        return;
      }

      validIds.forEach((requestId) => {
        sendMessage({
          type: 'chat.permission-response',
          requestId,
          allow: Boolean(decision?.allow),
          updatedInput: decision?.updatedInput,
          message: decision?.message,
          rememberEntry: decision?.rememberEntry,
        });
      });

      setPendingPermissionRequests((previous) =>
        previous.filter((request) => !validIds.includes(request.requestId)),
      );
    },
    [sendMessage, setPendingPermissionRequests],
  );

  const [isInputFocused, setIsInputFocused] = useState(false);

  const handleInputFocusChange = useCallback(
    (focused: boolean) => {
      setIsInputFocused(focused);
      onInputFocusChange?.(focused);
    },
    [onInputFocusChange],
  );

  return {
    handleAbortSession,
    handleGrantToolPermission,
    handlePermissionDecision,
    isInputFocused,
    handleInputFocusChange,
  };
}
