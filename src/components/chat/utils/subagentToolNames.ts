import type { ChatMessage } from '../types/types';

/**
 * Claude Code renamed its subagent-dispatch tool from `Task` to `Agent`.
 * Official agent-sdk docs recommend matching both names for compatibility;
 * old persisted transcripts still carry `Task`.
 */
export const SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set(['Agent', 'Task']);

export function isSubagentToolName(toolName: string | undefined): boolean {
  return typeof toolName === 'string' && SUBAGENT_TOOL_NAMES.has(toolName);
}

/**
 * The Agent tool's persisted content array can carry a trailing text block
 * that is runtime routing metadata (agentId/usage) for the model to continue
 * the conversation, not part of the subagent's actual result — exclude it.
 */
export function isAgentMetadataBlockText(text: string): boolean {
  return /^agentId: /.test(text);
}

/**
 * The Agent tool's result is, by construction, the subagent's final text
 * message — so when the transcript already ends with that plain assistant
 * text, a separate "Result" box would duplicate it verbatim. This predicate
 * gates that suppression: true only when the last child message is a plain
 * assistant text message (not a tool use) with non-empty trimmed content.
 */
export function transcriptEndsWithText(
  childMessages: readonly Pick<ChatMessage, 'type' | 'isToolUse' | 'content'>[],
): boolean {
  const lastChild = childMessages[childMessages.length - 1];
  return Boolean(lastChild && lastChild.type === 'assistant' && !lastChild.isToolUse && (lastChild.content || '').trim());
}
