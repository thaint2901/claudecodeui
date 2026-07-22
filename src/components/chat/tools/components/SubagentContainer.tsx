import React, { useState } from 'react';

import type { SubagentChildTool, ChatMessage } from '../../types/types';

import { SubagentTranscriptPanel } from './SubagentTranscriptPanel';

interface SubagentContainerProps {
  toolInput: unknown;
  toolResult?: { content?: unknown; isError?: boolean } | null;
  subagentState: {
    childTools: SubagentChildTool[];
    childMessages: ChatMessage[];
    currentToolIndex: number;
    isComplete: boolean;
  };
}

const getCompactToolDisplay = (toolName: string, toolInput: unknown): string => {
  const input = typeof toolInput === 'string' ? (() => {
    try { return JSON.parse(toolInput); } catch { return {}; }
  })() : (toolInput || {});

  switch (toolName) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'ApplyPatch':
      return input.file_path?.split('/').pop() || input.file_path || '';
    case 'Grep':
    case 'Glob':
      return input.pattern || '';
    case 'Bash':
      const cmd = input.command || '';
      return cmd.length > 40 ? `${cmd.slice(0, 40)}...` : cmd;
    case 'Task':
      return input.description || input.subagent_type || '';
    case 'WebFetch':
    case 'WebSearch':
      return input.url || input.query || '';
    default:
      return '';
  }
};

/**
 * Parses a tool result's content into a plain-text string, handling both the
 * raw string/array shapes and the JSON-stringified array-of-text-parts shape
 * the SDK sometimes emits for subagent (Task tool) results.
 */
const extractResultText = (toolResult?: { content?: unknown; isError?: boolean } | null): string | null => {
  if (!toolResult) return null;

  let content = toolResult.content;

  if (typeof content === 'string') {
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        const textParts = parsed
          .filter((p: any) => p.type === 'text' && p.text)
          .map((p: any) => p.text);
        if (textParts.length > 0) {
          content = textParts.join('\n');
        }
      }
    } catch {
      // Not JSON, use as-is
    }
  } else if (Array.isArray(content)) {
    const textParts = content
      .filter((p: any) => p.type === 'text' && p.text)
      .map((p: any) => p.text);
    if (textParts.length > 0) {
      content = textParts.join('\n');
    }
  }

  if (typeof content === 'string') return content;
  if (content) return JSON.stringify(content, null, 2);
  return null;
};

export const SubagentContainer: React.FC<SubagentContainerProps> = ({
  toolInput,
  toolResult,
  subagentState,
}) => {
  const [transcriptOpen, setTranscriptOpen] = useState(false);

  const parsedInput = typeof toolInput === 'string' ? (() => {
    try { return JSON.parse(toolInput); } catch { return {}; }
  })() : (toolInput || {});

  const subagentType = parsedInput?.subagent_type || 'Agent';
  const description = parsedInput?.description || 'Running task';
  const prompt = parsedInput?.prompt || '';
  const { childTools, childMessages, currentToolIndex, isComplete } = subagentState;
  const currentTool = currentToolIndex >= 0 ? childTools[currentToolIndex] : null;

  const title = `Subagent / ${subagentType}: ${description}`;
  const finalResult = isComplete ? extractResultText(toolResult) : null;
  const trimmedResult = finalResult
    ? (finalResult.length > 80 ? `${finalResult.slice(0, 80)}...` : finalResult)
    : null;

  return (
    <div className="my-1 border-l-2 border-l-purple-500 py-0.5 pl-3 dark:border-l-purple-400">
      <button
        type="button"
        onClick={() => setTranscriptOpen(true)}
        className="flex w-full select-none items-center gap-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <span className="flex-shrink-0 font-medium text-foreground">Task</span>
        <span className="flex-shrink-0 text-[10px] text-muted-foreground/40">/</span>
        <span className="flex-1 truncate text-left">{title}</span>
        <span className="flex-shrink-0 text-[10px] text-muted-foreground/60">View transcript</span>
      </button>

      {/* Current tool indicator (while running) */}
      {currentTool && !isComplete && (
        <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="h-1.5 w-1.5 flex-shrink-0 animate-pulse rounded-full bg-purple-500 dark:bg-purple-400" />
          <span className="text-muted-foreground/60">Currently:</span>
          <span className="font-medium text-foreground">{currentTool.toolName}</span>
          {getCompactToolDisplay(currentTool.toolName, currentTool.toolInput) && (
            <>
              <span className="text-muted-foreground/40">/</span>
              <span className="truncate font-mono text-muted-foreground">
                {getCompactToolDisplay(currentTool.toolName, currentTool.toolInput)}
              </span>
            </>
          )}
        </div>
      )}

      {/* Completion status */}
      {isComplete && (
        <div className="mt-1 flex items-center gap-1.5 text-xs text-green-600 dark:text-green-400">
          <svg className="h-3 w-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          <span className="flex-shrink-0">Completed ({childTools.length} {childTools.length === 1 ? 'tool' : 'tools'})</span>
          {trimmedResult && (
            <span className="truncate text-muted-foreground">{trimmedResult}</span>
          )}
        </div>
      )}

      <SubagentTranscriptPanel
        open={transcriptOpen}
        onClose={() => setTranscriptOpen(false)}
        title={title}
        prompt={prompt}
        childMessages={childMessages}
        isComplete={isComplete}
        finalResult={finalResult}
      />
    </div>
  );
};
