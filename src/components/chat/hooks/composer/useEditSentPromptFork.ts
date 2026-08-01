import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from 'react';

export interface EditingSentPrompt {
  uuid: string;
  content: string;
}

export interface LastEditSubmission {
  uuid: string;
  content: string;
}

interface UseEditSentPromptForkParams {
  /** Selected session key; switching sessions cancels any in-progress edit. */
  sessionKey: string | null;
  /** Focused after starting or restoring an edit, matching pre-extraction behavior. */
  textareaRef: RefObject<HTMLTextAreaElement>;
  /** Mirrors a new composer value into both `input` state and `inputValueRef`; owned by the orchestrator. */
  setInputValue: (value: string) => void;
}

export interface EditSentPromptForkApi {
  editingSentPrompt: EditingSentPrompt | null;
  setEditingSentPrompt: Dispatch<SetStateAction<EditingSentPrompt | null>>;
  editingSentPromptRef: RefObject<EditingSentPrompt | null>;
  lastEditSubmissionRef: MutableRefObject<LastEditSubmission | null>;
  startEditSentPrompt: (uuid: string, content: string) => void;
  cancelEditSentPrompt: () => void;
  restoreEditSentPrompt: () => boolean;
  clearEditSubmission: () => void;
}

export function useEditSentPromptFork({
  sessionKey,
  textareaRef,
  setInputValue,
}: UseEditSentPromptForkParams): EditSentPromptForkApi {
  /** Set while composing a reply to an edited (previously sent) prompt; drives `editAtMessageUuid`. */
  const [editingSentPrompt, setEditingSentPrompt] = useState<EditingSentPrompt | null>(null);
  // Survives the unconditional composer clear in handleSubmit so a FORK_FAILED
  // can hand the edit back. Cleared as soon as it is restored or cancelled.
  const lastEditSubmissionRef = useRef<LastEditSubmission | null>(null);

  const startEditSentPrompt = useCallback((uuid: string, content: string) => {
    setEditingSentPrompt({ uuid, content });
    setInputValue(content);
    textareaRef.current?.focus();
  }, [setInputValue, textareaRef]);

  const cancelEditSentPrompt = useCallback(() => {
    setEditingSentPrompt(null);
    setInputValue('');
    lastEditSubmissionRef.current = null;
  }, [setInputValue]);

  /**
   * Puts a failed fork's edited text back in the composer and re-enters edit
   * mode, so the user can retry or copy it out. Returns false when there is
   * nothing to restore (the failure did not come from an edit submission).
   */
  const restoreEditSentPrompt = useCallback(() => {
    const pending = lastEditSubmissionRef.current;
    if (!pending) return false;
    lastEditSubmissionRef.current = null;
    setEditingSentPrompt({ uuid: pending.uuid, content: pending.content });
    setInputValue(pending.content);
    textareaRef.current?.focus();
    return true;
  }, [setInputValue, textareaRef]);

  /**
   * Drops the held edit text without touching the composer. Called once the
   * fork is known to have landed: the text has served its purpose, and leaving
   * it behind meant a LATER unrelated failure could push a stale edit — and its
   * stale anchor uuid — back into the composer.
   */
  const clearEditSubmission = useCallback(() => {
    lastEditSubmissionRef.current = null;
  }, []);

  // Edit-sent-prompt state is anchored to a specific message uuid in the
  // session being viewed; ChatInterface never remounts on a session switch,
  // so without this it would survive into the new session and reuse a stale
  // anchor. Switching away mid-edit is treated as CANCEL: the composer text
  // is the edit prefill (written by startEditSentPrompt into the per-project
  // draft), so it is cleared along with the anchor — but only when an edit
  // was actually active, so ordinary per-project drafts are left alone.
  const editingSentPromptRef = useRef(editingSentPrompt);
  useEffect(() => {
    editingSentPromptRef.current = editingSentPrompt;
  }, [editingSentPrompt]);
  useEffect(() => {
    // Unconditionally: the held edit text is anchored to a uuid in the session
    // being left, so it must not survive to be restored into another one — and
    // it outlives the edit-mode flag, which `handleSubmit` already cleared.
    lastEditSubmissionRef.current = null;
    if (!editingSentPromptRef.current) {
      return;
    }
    setEditingSentPrompt(null);
    setInputValue('');
  }, [sessionKey, setInputValue]);

  return {
    editingSentPrompt,
    setEditingSentPrompt,
    editingSentPromptRef,
    lastEditSubmissionRef,
    startEditSentPrompt,
    cancelEditSentPrompt,
    restoreEditSentPrompt,
    clearEditSubmission,
  };
}
