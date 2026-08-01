import { useCallback, useEffect, useRef } from 'react';
import type {
  ChangeEvent,
  Dispatch,
  FormEvent,
  MouseEvent,
  MutableRefObject,
  RefObject,
  SetStateAction,
} from 'react';

import { safeLocalStorage } from '../../utils/chatStorage';

interface UseComposerDraftParams {
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  /**
   * Owned by the orchestrator (see `useChatComposerState`) — mirrors `input`
   * for synchronous reads elsewhere (handleSubmit, voice transcript, etc.).
   * This hook keeps it in sync wherever it writes `input` itself.
   */
  inputValueRef: MutableRefObject<string>;
  selectedProjectId: string | undefined;
  /**
   * Owned by the orchestrator — five sibling hooks called before this one
   * (useEditSentPromptFork, useMessageQueue, useSlashDispatch,
   * useSlashCommands, useFileMentions) already take the same ref as a param,
   * so it can't be created here without reordering those calls.
   */
  textareaRef: RefObject<HTMLTextAreaElement>;
  /**
   * Owned by the orchestrator — useSlashDispatch (called earlier) also needs
   * the setter, so the state itself can't live in this hook either.
   */
  setIsTextareaExpanded: Dispatch<SetStateAction<boolean>>;
  resetCommandMenuState: () => void;
  handleCommandInputChange: (value: string, cursorPosition: number) => void;
  setCursorPosition: (position: number) => void;
}

export interface ComposerDraftApi {
  inputHighlightRef: MutableRefObject<HTMLDivElement | null>;
  handleInputChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  handleTextareaClick: (event: MouseEvent<HTMLTextAreaElement>) => void;
  handleTextareaInput: (event: FormEvent<HTMLTextAreaElement>) => void;
  syncInputOverlayScroll: (target: HTMLTextAreaElement) => void;
  handleClearInput: () => void;
}

/**
 * Textarea mechanics for the composer: autosize, the highlight-overlay
 * scroll mirror, and the per-project localStorage draft persist/restore.
 * Does NOT own `input`/`setInput`/`textareaRef`/`isTextareaExpanded` — those
 * are the orchestrator's; this hook only manages the DOM/ref bookkeeping
 * around them (see param docs above for why each stays put).
 */
export function useComposerDraft({
  input,
  setInput,
  inputValueRef,
  selectedProjectId,
  textareaRef,
  setIsTextareaExpanded,
  resetCommandMenuState,
  handleCommandInputChange,
  setCursorPosition,
}: UseComposerDraftParams): ComposerDraftApi {
  const inputHighlightRef = useRef<HTMLDivElement>(null);
  const textareaLineHeightRef = useRef<number | null>(null);
  const lastAutosizedInputRef = useRef<string | null>(null);

  const syncInputOverlayScroll = useCallback((target: HTMLTextAreaElement) => {
    if (!inputHighlightRef.current || !target) {
      return;
    }
    inputHighlightRef.current.scrollTop = target.scrollTop;
    inputHighlightRef.current.scrollLeft = target.scrollLeft;
  }, []);

  const resizeTextarea = useCallback((target: HTMLTextAreaElement) => {
    target.style.height = 'auto';
    const nextHeight = Math.max(22, target.scrollHeight);
    target.style.height = `${nextHeight}px`;

    let lineHeight = textareaLineHeightRef.current;
    if (!lineHeight) {
      lineHeight = parseInt(window.getComputedStyle(target).lineHeight);
      textareaLineHeightRef.current = Number.isFinite(lineHeight) ? lineHeight : 24;
    }

    const expanded = nextHeight > (textareaLineHeightRef.current || 24) * 2;
    setIsTextareaExpanded((previous) => previous === expanded ? previous : expanded);
    lastAutosizedInputRef.current = target.value;
  }, [setIsTextareaExpanded]);

  useEffect(() => {
    if (!selectedProjectId) {
      return;
    }
    const savedInput = safeLocalStorage.getItem(`draft_input_${selectedProjectId}`) || '';
    setInput((previous) => {
      const next = previous === savedInput ? previous : savedInput;
      inputValueRef.current = next;
      return next;
    });
  }, [selectedProjectId, setInput, inputValueRef]);

  useEffect(() => {
    if (!selectedProjectId) {
      return;
    }
    if (input !== '') {
      safeLocalStorage.setItem(`draft_input_${selectedProjectId}`, input);
    } else {
      safeLocalStorage.removeItem(`draft_input_${selectedProjectId}`);
    }
  }, [input, selectedProjectId]);

  useEffect(() => {
    if (!textareaRef.current) {
      return;
    }
    if (lastAutosizedInputRef.current === input) {
      return;
    }
    // Re-run for restored drafts and programmatic input changes. User typing is
    // already resized in onInput, so this avoids doing the same forced layout twice.
    resizeTextarea(textareaRef.current);
  }, [input, resizeTextarea, textareaRef]);

  useEffect(() => {
    if (!textareaRef.current || input.trim()) {
      return;
    }
    textareaRef.current.style.height = 'auto';
    setIsTextareaExpanded(false);
  }, [input, setIsTextareaExpanded, textareaRef]);

  const handleInputChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = event.target.value;
      const cursorPos = event.target.selectionStart;

      setInput(newValue);
      inputValueRef.current = newValue;
      setCursorPosition(cursorPos);

      if (!newValue.trim()) {
        event.target.style.height = 'auto';
        setIsTextareaExpanded(false);
        resetCommandMenuState();
        return;
      }

      handleCommandInputChange(newValue, cursorPos);
    },
    [
      handleCommandInputChange,
      resetCommandMenuState,
      setCursorPosition,
      setInput,
      inputValueRef,
      setIsTextareaExpanded,
    ],
  );

  const handleTextareaClick = useCallback(
    (event: MouseEvent<HTMLTextAreaElement>) => {
      setCursorPosition(event.currentTarget.selectionStart);
    },
    [setCursorPosition],
  );

  const handleTextareaInput = useCallback(
    (event: FormEvent<HTMLTextAreaElement>) => {
      const target = event.currentTarget;
      resizeTextarea(target);
      setCursorPosition(target.selectionStart);
      syncInputOverlayScroll(target);
    },
    [resizeTextarea, setCursorPosition, syncInputOverlayScroll],
  );

  const handleClearInput = useCallback(() => {
    setInput('');
    inputValueRef.current = '';
    resetCommandMenuState();
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.focus();
    }
    setIsTextareaExpanded(false);
  }, [resetCommandMenuState, setInput, inputValueRef, setIsTextareaExpanded, textareaRef]);

  return {
    inputHighlightRef,
    handleInputChange,
    handleTextareaClick,
    handleTextareaInput,
    syncInputOverlayScroll,
    handleClearInput,
  };
}
