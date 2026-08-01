import { useCallback, useEffect, useRef, useState } from 'react';
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

import {
  clearQueuedMessage,
  readQueuedMessage,
  writeQueuedMessage,
  type QueuedSendOptions,
} from '../../utils/chatStorage';

export type QueuedDraft = {
  content: string;
  images: File[];
  /**
   * Send options snapshotted at queue time. Persisted with the draft so the
   * app-level auto-send can dispatch the message with the right model and
   * permission settings while another session is being viewed.
   */
  options?: QueuedSendOptions;
};

const restoreQueuedDraft = (sessionKey: string): QueuedDraft | null => {
  const saved = readQueuedMessage(sessionKey);
  // Image attachments can't survive a reload; only text and options persist.
  return saved ? { content: saved.content, images: [], options: saved.options } : null;
};

const createFakeSubmitEvent = () => {
  return { preventDefault: () => undefined } as unknown as FormEvent<HTMLFormElement>;
};

/**
 * The flush effect's actual gate. `previousSessionKey` is the ref's value from
 * before this render — a mismatch means a session switch is mid-transition
 * (the commit where `sessionKey` already points at the new session while
 * `queuedDraft` still describes the old one), which must never flush. Unlike
 * the effect's `wasLoading`, this predicate has no memory of a prior flush:
 * `wasLoading` only picks the delay (immediate vs 750ms debounce) once this
 * gate has already said yes.
 */
export function shouldFlushQueuedDraft(args: {
  isLoading: boolean;
  queuedDraft: QueuedDraft | null;
  sessionKey: string | null;
  previousSessionKey: string | null;
}): boolean {
  if (args.previousSessionKey !== args.sessionKey) {
    return false;
  }
  return !args.isLoading && Boolean(args.queuedDraft);
}

interface UseMessageQueueParams {
  sessionKey: string | null;
  isLoading: boolean;
  textareaRef: RefObject<HTMLTextAreaElement>;
  /** Orchestrator-owned; the flush effect replays the queued draft through it. */
  handleSubmitRef: MutableRefObject<
    ((event: FormEvent<HTMLFormElement> | MouseEvent | TouchEvent | KeyboardEvent<HTMLTextAreaElement>) => Promise<void>) | null
  >;
  /** Mirrors restored draft text/images into the composer's input + attachment state; built by the orchestrator from setInputValue + setAttachedImages. */
  restoreDraft: (text: string, images: File[]) => void;
}

export interface MessageQueueApi {
  queuedDraft: QueuedDraft | null;
  setQueuedDraft: Dispatch<SetStateAction<QueuedDraft | null>>;
  /** Which session the in-memory `queuedDraft` belongs to; handleSubmit stamps this when it queues a new draft. */
  queuedDraftSessionRef: MutableRefObject<string | null>;
  editQueuedDraft: () => void;
  deleteQueuedDraft: () => void;
}

export function useMessageQueue({
  sessionKey,
  isLoading,
  textareaRef,
  handleSubmitRef,
  restoreDraft,
}: UseMessageQueueParams): MessageQueueApi {
  const [queuedDraft, setQueuedDraft] = useState<QueuedDraft | null>(() => {
    if (typeof window === 'undefined' || !sessionKey) {
      return null;
    }
    return restoreQueuedDraft(sessionKey);
  });
  // Which session the in-memory `queuedDraft` belongs to. On a session switch
  // there is one commit where `sessionKey` already points at the new session
  // while `queuedDraft` still holds the old session's draft; the persistence
  // effect must not write across that gap.
  const queuedDraftSessionRef = useRef<string | null>(sessionKey);

  // Once the in-flight turn ends, replay the queued draft through the normal
  // submit path (slash commands, image upload, etc. all still apply).
  const wasLoadingRef = useRef(isLoading);
  const flushSessionKeyRef = useRef(sessionKey);
  useEffect(() => {
    const wasLoading = wasLoadingRef.current;
    wasLoadingRef.current = isLoading;
    const previousSessionKey = flushSessionKeyRef.current;
    flushSessionKeyRef.current = sessionKey;

    if (!shouldFlushQueuedDraft({ isLoading, queuedDraft, sessionKey, previousSessionKey }) || !queuedDraft) {
      return;
    }

    // Turn just ended in this session: flush immediately. Otherwise this is a
    // saved draft restored into an apparently idle session — hold it briefly
    // so the `chat_subscribed` ack can flip `isLoading` if a run is actually
    // still live (the cleanup below cancels the send in that case).
    const delay = wasLoading ? 0 : 750;
    const timer = setTimeout(() => {
      // The saved key is the claim ticket shared with the app-level auto-send
      // (which handles sessions that finish while not viewed). If it's gone,
      // the message was already dispatched — don't send it twice.
      if (sessionKey && !readQueuedMessage(sessionKey)) {
        setQueuedDraft(null);
        return;
      }
      setQueuedDraft(null);
      restoreDraft(queuedDraft.content, queuedDraft.images);
      setTimeout(() => {
        handleSubmitRef.current?.(createFakeSubmitEvent());
      }, 0);
    }, delay);
    return () => clearTimeout(timer);
  }, [isLoading, queuedDraft, sessionKey, restoreDraft, handleSubmitRef]);

  // Persist the queued draft under its session's key. Must be defined BEFORE
  // the swap effect below: on a session switch there is one commit where
  // `sessionKey` already points at the new session while `queuedDraft` (and
  // the owner ref) still describe the old one — the ref mismatch makes this
  // effect skip that commit instead of writing/clearing across sessions.
  useEffect(() => {
    if (!sessionKey || queuedDraftSessionRef.current !== sessionKey) {
      return;
    }
    if (queuedDraft?.content) {
      writeQueuedMessage(sessionKey, { content: queuedDraft.content, options: queuedDraft.options });
    } else {
      clearQueuedMessage(sessionKey);
    }
  }, [queuedDraft, sessionKey]);

  // Switching sessions swaps in that session's queued draft (image
  // attachments can't survive a reload, so only text and options restore).
  useEffect(() => {
    queuedDraftSessionRef.current = sessionKey;
    if (!sessionKey) {
      setQueuedDraft(null);
      return;
    }
    setQueuedDraft(restoreQueuedDraft(sessionKey));
  }, [sessionKey]);

  const editQueuedDraft = useCallback(() => {
    if (!queuedDraft) {
      return;
    }
    setQueuedDraft(null);
    restoreDraft(queuedDraft.content, queuedDraft.images);
    textareaRef.current?.focus();
  }, [queuedDraft, restoreDraft, textareaRef]);

  const deleteQueuedDraft = useCallback(() => {
    setQueuedDraft(null);
  }, []);

  return {
    queuedDraft,
    setQueuedDraft,
    queuedDraftSessionRef,
    editQueuedDraft,
    deleteQueuedDraft,
  };
}
