import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

import type { ChatMessage } from '../../types/types';
import { ToolRenderer } from '../ToolRenderer';

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

/**
 * Slide-over drawer showing a subagent's full transcript at main-session
 * fidelity. Read-only, live-updating (childMessages re-derive on every store
 * change while the run streams). Deliberately NOT a route: closing it must
 * return to the exact main-session scroll position.
 */
export const SubagentTranscriptPanel: React.FC<SubagentTranscriptPanelProps> = ({
  open, onClose, title, prompt, childMessages, isComplete, finalResult,
}) => {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[1100]" role="dialog" aria-label={title}>
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="absolute bottom-0 right-0 top-0 flex w-full max-w-2xl flex-col border-l border-border bg-background shadow-2xl">
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-foreground">{title}</div>
            <div className="text-xs text-muted-foreground">
              {isComplete ? 'Completed' : 'Running…'}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Close subagent transcript"
          >
            <X size={14} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {prompt && (
            <div className="mb-3 rounded-md border border-border bg-muted/40 p-2 text-xs">
              <div className="mb-1 font-semibold uppercase tracking-wide text-muted-foreground">Task</div>
              <div className="whitespace-pre-wrap break-words">{prompt}</div>
            </div>
          )}
          {childMessages.map((message, index) => {
            if (message.isToolUse) {
              return (
                <div key={message.toolId || index} className="my-1">
                  <ToolRenderer
                    toolName={message.toolName || 'UnknownTool'}
                    toolInput={message.toolInput}
                    toolResult={message.toolResult}
                    toolId={message.toolId}
                    mode="input"
                  />
                </div>
              );
            }
            return (
              <div
                key={index}
                className={`my-2 text-sm ${message.type === 'user' ? 'text-muted-foreground' : 'text-foreground'}`}
              >
                <MarkdownContent content={message.content || ''} />
              </div>
            );
          })}
          {isComplete && finalResult && (
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
