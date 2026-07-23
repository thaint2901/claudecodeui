import React, { useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

import type { ChatMessage } from '../../types/types';
import { Button } from '../../../../shared/view/ui/Button';
import { ToolRenderer } from '../ToolRenderer';
import { createCachedDiffCalculator, type DiffCalculator } from '../../utils/messageTransforms';
import { transcriptEndsWithText as computeTranscriptEndsWithText } from '../../utils/subagentToolNames';

import { MarkdownContent } from './ContentRenderers';

interface SubagentTranscriptPanelProps {
  open: boolean;
  onClose: () => void;
  title: string;
  prompt: string;
  childMessages: ChatMessage[];
  isComplete: boolean;
  finalResult: string | null;
}

const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Every mounted panel registers its keydown listener on `document` (capture
// phase) so nested panels (panel opened from inside another panel) can trap
// focus regardless of DOM position. Capture-phase listeners on the SAME
// target fire in registration order, not reverse — so the most-recently-
// mounted (topmost, innermost) panel's listener runs LAST, and
// stopPropagation/stopImmediatePropagation from it cannot un-run earlier
// listeners that already fired. This stack lets every panel check whether it
// is currently the topmost open panel before acting, so only one panel ever
// responds to a given Escape/Tab press.
let panelIdCounter = 0;
const openPanelStack: number[] = [];

/**
 * Slide-over drawer showing a subagent's full transcript at main-session
 * fidelity. Read-only, live-updating (childMessages re-derive on every store
 * change while the run streams). Deliberately NOT a route: closing it must
 * return to the exact main-session scroll position.
 *
 * This panel hand-rolls its own overlay plumbing rather than reusing
 * `src/shared/view/ui/Dialog.tsx` because `DialogContent` hardcodes a
 * centered-modal layout (`left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2
 * w-full max-w-lg` plus a scale/fade entrance animation). Overriding those
 * utility classes to express a right-anchored, full-height drawer would
 * leave `left-1/2` fighting a `right-0` override in the same box — with
 * `width` also set explicitly, CSS treats the box as over-constrained and
 * drops `right`, so the drawer would not reliably stick to the right edge.
 * Instead this panel brings its own plumbing up to parity with Dialog:
 * aria-modal, an initial-focus effect, focus restore on close, a Tab focus
 * trap, and a body scroll lock.
 */
export const SubagentTranscriptPanel: React.FC<SubagentTranscriptPanelProps> = ({
  open, onClose, title, prompt, childMessages, isComplete, finalResult,
}) => {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const panelIdRef = useRef<number>();
  if (panelIdRef.current === undefined) {
    panelIdRef.current = ++panelIdCounter;
  }

  // This panel renders inside a portal, out of reach of the main pane's
  // single diff-calculator instance (created in useChatSessionState.ts), so
  // it caches its own rather than sharing one.
  const createDiff = useMemo<DiffCalculator>(() => createCachedDiffCalculator(), []);

  // The Agent tool's result is, by construction, the subagent's final text
  // message — so when the transcript already ends with that plain assistant
  // text, the Result box below would duplicate it verbatim. It stays as a
  // fallback for transcripts that don't end with a trailing text message
  // (forwarding off, incomplete transcripts): error results are normally
  // shown via the per-tool error boxes above, but finalResult for an error
  // still renders here when the transcript lacks a trailing text message.
  const transcriptEndsWithText = useMemo(() => computeTranscriptEndsWithText(childMessages), [childMessages]);

  useEffect(() => {
    if (!open) return;
    const panelId = panelIdRef.current!;
    openPanelStack.push(panelId);
    const onKey = (e: KeyboardEvent) => {
      // Only the topmost open panel (last one pushed onto the stack) reacts;
      // see the comment above `openPanelStack` for why this — not
      // stopPropagation — is what makes "topmost wins" hold.
      if (openPanelStack[openPanelStack.length - 1] !== panelId) return;
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key === 'Tab' && panelRef.current) {
        const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);

    previousFocusRef.current = document.activeElement as HTMLElement;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(() => {
      const first = panelRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      first?.focus();
    });

    return () => {
      document.removeEventListener('keydown', onKey, true);
      const idx = openPanelStack.indexOf(panelId);
      if (idx !== -1) openPanelStack.splice(idx, 1);
      document.body.style.overflow = prevOverflow;
      previousFocusRef.current?.focus();
      previousFocusRef.current = null;
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[1100]" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div
        ref={panelRef}
        className="absolute bottom-0 right-0 top-0 flex w-full max-w-2xl flex-col border-l border-border bg-background shadow-2xl"
      >
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-foreground">{title}</div>
            <div className="text-xs text-muted-foreground">
              {isComplete ? 'Completed' : 'Running…'}
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={onClose}
            className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
            aria-label="Close subagent transcript"
          >
            <X size={14} />
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {prompt && (
            <div className="mb-3 rounded-md border border-border bg-muted/40 p-2 text-xs">
              <div className="mb-1 font-semibold uppercase tracking-wide text-muted-foreground">Task</div>
              <div className="whitespace-pre-wrap break-words">{prompt}</div>
            </div>
          )}
          {childMessages.map((message, index) => {
            const key = message.toolId || `${String(message.timestamp)}-${index}`;
            if (message.isToolUse) {
              return (
                <div key={key} className="my-1">
                  {message.displayText && (
                    <div className="mb-1 text-sm text-foreground">{message.displayText}</div>
                  )}
                  <ToolRenderer
                    toolName={message.toolName || 'UnknownTool'}
                    toolInput={message.toolInput}
                    toolResult={message.toolResult}
                    toolId={message.toolId}
                    mode="input"
                    createDiff={createDiff}
                    isSubagentContainer={message.isSubagentContainer}
                    subagentState={message.subagentState}
                  />
                  {/* Bash already shows failures inline in its command row above. */}
                  {message.toolResult?.isError && message.toolName !== 'Bash' && (
                    <div className="mt-2 rounded border border-red-500/30 bg-red-500/5 p-2 text-xs">
                      <div className="mb-1 font-semibold uppercase tracking-wide text-red-600 dark:text-red-400">Error</div>
                      <div className="whitespace-pre-wrap break-words text-red-900 dark:text-red-100">
                        {String(message.toolResult.content || '')}
                      </div>
                    </div>
                  )}
                </div>
              );
            }
            return (
              <div
                key={key}
                className={`my-2 text-sm ${message.type === 'user' ? 'text-muted-foreground' : 'text-foreground'}`}
              >
                <MarkdownContent content={message.content || ''} />
              </div>
            );
          })}
          {isComplete && childMessages.length === 0 && (
            <div className="text-xs text-muted-foreground">No transcript available for this subagent.</div>
          )}
          {isComplete && finalResult && !transcriptEndsWithText && (
            <div className="mt-3 rounded-md border border-green-500/30 bg-green-500/5 p-2 text-xs">
              <div className="mb-1 font-semibold uppercase tracking-wide text-green-600 dark:text-green-400">Result</div>
              <MarkdownContent content={finalResult} />
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
};
