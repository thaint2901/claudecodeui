/**
 * Message normalization utilities.
 * Converts NormalizedMessage[] from the session store into ChatMessage[] for the UI.
 */

import type { NormalizedMessage } from '../../../stores/useSessionStore';
import type { ChatMessage, SubagentChildTool } from '../types/types';
import { decodeHtmlEntities, unescapeWithMathProtection, formatUsageLimitText } from '../utils/chatFormatting';
import { isSubagentToolName } from '../utils/subagentToolNames';

function formatToolResultContent(content: unknown): string {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  const toolUseErrorMatch = /^<tool_use_error>([\s\S]*)<\/tool_use_error>$/.exec(text.trim());
  return toolUseErrorMatch ? toolUseErrorMatch[1] : text;
}

type ParsedTaskNotification = {
  status: string;
  summary: string;
  result: string;
};

/**
 * Parses a background-agent `<task-notification>` block.
 *
 * The harness injects these as user-role messages when a background task stops.
 * Newer notifications carry extra fields (`<tool-use-id>`, `<note>`, `<usage>`,
 * and a `<result>` markdown payload) that the previous single-shot regex could
 * not match, so the whole raw XML block leaked through as plain user text.
 * Fields are extracted independently so the block renders as an assistant
 * notification plus, when present, the agent's markdown result.
 */
function parseTaskNotification(content: string): ParsedTaskNotification | null {
  if (!content.trimStart().startsWith('<task-notification>')) {
    return null;
  }

  const statusMatch = /<status>([\s\S]*?)<\/status>/.exec(content);
  const summaryMatch = /<summary>([\s\S]*?)<\/summary>/.exec(content);

  let result = '';
  const resultOpen = content.indexOf('<result>');
  if (resultOpen !== -1) {
    const afterOpen = content.slice(resultOpen + '<result>'.length);
    const closeIndex = afterOpen.indexOf('</result>');
    result =
      closeIndex === -1
        ? afterOpen.replace(/<\/task-notification>\s*$/, '').trim()
        : afterOpen.slice(0, closeIndex).trim();
  }

  return {
    status: statusMatch?.[1]?.trim() || 'completed',
    summary: summaryMatch?.[1]?.trim() || 'Background task finished',
    result,
  };
}

/**
 * Convert NormalizedMessage[] from the session store into ChatMessage[]
 * that the existing UI components expect.
 *
 * Truly internal/system content is already filtered server-side. Some Claude
 * transcript artifacts such as local slash commands and compact summaries are
 * intentionally preserved and annotated so they can render like normal chat.
 */
export function normalizedToChatMessages(messages: NormalizedMessage[]): ChatMessage[] {
  // Group subagent children under their parent. `parentToolUseId` is the one
  // data contract both delivery paths honor: the live SDK stream sets it in
  // claude-sdk.js, the persisted reader stamps it during JSONL reconstruction.
  //
  // Built ONCE from the full flat array and threaded through the recursive
  // conversion below (rather than re-partitioned per nesting level) so a
  // nested Agent's own children resolve correctly. Children whose parent
  // tool_use is on an older, not-yet-loaded page are intentionally dropped
  // from view and self-heal when that page loads — same policy as the
  // orphaned tool_result skip further down.
  const childrenByParent = new Map<string, NormalizedMessage[]>();
  const topLevel: NormalizedMessage[] = [];
  for (const msg of messages) {
    if (typeof msg.parentToolUseId === 'string' && msg.parentToolUseId) {
      const siblings = childrenByParent.get(msg.parentToolUseId) ?? [];
      siblings.push(msg);
      childrenByParent.set(msg.parentToolUseId, siblings);
    } else {
      topLevel.push(msg);
    }
  }

  return convertMessages(topLevel, childrenByParent);
}

/**
 * Converts one level of messages (top-level or a subagent's direct children)
 * into ChatMessage[], using a single shared `childrenByParent` map (keyed by
 * `parentToolUseId`, built once from the full flat array) for grouping at
 * every nesting level. Recursing with this same map — rather than
 * re-partitioning a slice — is what lets a nested Agent's own children
 * (grandchildren of the outer call) resolve correctly.
 */
function convertMessages(
  topLevel: NormalizedMessage[],
  childrenByParent: Map<string, NormalizedMessage[]>,
): ChatMessage[] {
  const converted: ChatMessage[] = [];

  // First pass: collect tool results for attachment
  const toolResultMap = new Map<string, NormalizedMessage>();
  const toolUseIds = new Set<string>();
  for (const msg of topLevel) {
    if (msg.kind === 'tool_use' && msg.toolId) {
      toolUseIds.add(msg.toolId);
    }

    if (msg.kind === 'tool_result' && msg.toolId) {
      toolResultMap.set(msg.toolId, msg);
    }
  }

  for (const msg of topLevel) {
    const sharedMetadata = {
      displayText: msg.displayText,
      commandName: msg.commandName,
      commandMessage: msg.commandMessage,
      commandArgs: msg.commandArgs,
      isLocalCommand: msg.isLocalCommand,
      isLocalCommandStdout: msg.isLocalCommandStdout,
      isCompactSummary: msg.isCompactSummary,
    };

    switch (msg.kind) {
      case 'text': {
        const content = msg.content || '';
        const images = Array.isArray(msg.images) && msg.images.length > 0 ? msg.images : undefined;
        if (!content.trim() && !images) continue;

        if (msg.role === 'user') {
          // Parse task notifications
          const taskNotif = parseTaskNotification(content);
          if (taskNotif) {
            converted.push({
              type: 'assistant',
              content: taskNotif.summary,
              timestamp: msg.timestamp,
              isTaskNotification: true,
              taskStatus: taskNotif.status,
              ...sharedMetadata,
            });
            // Render the agent's result as a normal assistant message so its
            // markdown displays correctly instead of leaking raw XML.
            if (taskNotif.result) {
              converted.push({
                type: 'assistant',
                content: formatUsageLimitText(unescapeWithMathProtection(decodeHtmlEntities(taskNotif.result))),
                timestamp: msg.timestamp,
                ...sharedMetadata,
              });
            }
          } else {
            converted.push({
              type: 'user',
              content: unescapeWithMathProtection(decodeHtmlEntities(content)),
              timestamp: msg.timestamp,
              images,
              ...sharedMetadata,
            });
          }
        } else {
          let text = decodeHtmlEntities(content);
          text = unescapeWithMathProtection(text);
          text = formatUsageLimitText(text);
          converted.push({
            type: 'assistant',
            content: text,
            timestamp: msg.timestamp,
            ...sharedMetadata,
          });
        }
        break;
      }

      case 'tool_use': {
        const tr = msg.toolResult || (msg.toolId ? toolResultMap.get(msg.toolId) : null);
        const isSubagentContainer = isSubagentToolName(msg.toolName);

        const children = (msg.toolId && childrenByParent.get(msg.toolId)) || [];
        const childTools: SubagentChildTool[] = [];
        if (isSubagentContainer && children.length > 0) {
          const childResults = new Map<string, NormalizedMessage>();
          for (const child of children) {
            if (child.kind === 'tool_result' && child.toolId) childResults.set(child.toolId, child);
          }
          for (const child of children) {
            if (child.kind !== 'tool_use' || !child.toolId) continue;
            const childResult = childResults.get(child.toolId);
            childTools.push({
              toolId: child.toolId,
              toolName: child.toolName || 'UnknownTool',
              toolInput: child.toolInput,
              toolResult: childResult
                ? { content: formatToolResultContent(childResult.content), isError: Boolean(childResult.isError) }
                : null,
              timestamp: new Date(child.timestamp || Date.now()),
            });
          }
        }
        // Full child transcript for the drawer: recurse with the SAME shared
        // childrenByParent map so a nested Agent's own children (grandchildren
        // of this call, keyed under the nested Agent's toolId) resolve too.
        const childMessages = isSubagentContainer && children.length > 0
          ? convertMessages(children, childrenByParent)
          : [];

        const toolResult = tr
          ? {
              content: formatToolResultContent(tr.content),
              isError: Boolean(tr.isError),
              toolUseResult: (tr as any).toolUseResult,
            }
          : null;

        converted.push({
          type: 'assistant',
          content: '',
          timestamp: msg.timestamp,
          isToolUse: true,
          toolName: msg.toolName,
          toolInput: typeof msg.toolInput === 'string' ? msg.toolInput : JSON.stringify(msg.toolInput ?? '', null, 2),
          toolId: msg.toolId,
          toolResult,
          isSubagentContainer,
          subagentState: isSubagentContainer
            ? {
                childTools,
                childMessages,
                currentToolIndex: childTools.length > 0 ? childTools.length - 1 : -1,
                isComplete: Boolean(toolResult),
              }
            : undefined,
          ...sharedMetadata,
        });
        break;
      }

      case 'thinking':
        if (msg.content?.trim()) {
          converted.push({
            type: 'assistant',
            content: unescapeWithMathProtection(msg.content),
            timestamp: msg.timestamp,
            isThinking: true,
            ...sharedMetadata,
          });
        }
        break;

      case 'error':
        converted.push({
          type: 'error',
          content: msg.content || 'Unknown error',
          timestamp: msg.timestamp,
          ...sharedMetadata,
        });
        break;

      case 'interactive_prompt':
        converted.push({
          type: 'assistant',
          content: msg.content || '',
          timestamp: msg.timestamp,
          isInteractivePrompt: true,
          ...sharedMetadata,
        });
        break;

      case 'task_notification':
        converted.push({
          type: 'assistant',
          content: msg.summary || 'Background task update',
          timestamp: msg.timestamp,
          isTaskNotification: true,
          taskStatus: msg.status || 'completed',
          ...sharedMetadata,
        });
        break;

      case 'stream_delta':
        if (msg.content) {
          converted.push({
            type: 'assistant',
            content: msg.content,
            timestamp: msg.timestamp,
            isStreaming: true,
            ...sharedMetadata,
          });
        }
        break;

      // stream_end, complete, status, permission_*, session_created
      // are control events — not rendered as messages
      case 'stream_end':
      case 'complete':
      case 'status':
      case 'permission_request':
      case 'permission_cancelled':
      case 'session_created':
        // Skip — these are handled by useChatRealtimeHandlers
        break;

      // tool_result is handled via attachment to tool_use above
      case 'tool_result': {
        if (msg.toolId && toolUseIds.has(msg.toolId)) {
          break;
        }

        // A result with a toolId but no matching tool_use in the loaded set is
        // almost always a tool_use/tool_result pair split across a pagination
        // boundary (older page not loaded yet). Rendering its raw content here
        // produces an unstyled dump that "fixes itself" once the older page
        // loads; skip it and let it attach to its tool_use when that arrives.
        if (msg.toolId) {
          break;
        }

        const content = formatToolResultContent(msg.content || '');
        if (!content.trim()) {
          break;
        }

        converted.push({
          type: msg.isError ? 'error' : 'assistant',
          content,
          timestamp: msg.timestamp,
          toolId: msg.toolId,
          ...sharedMetadata,
        });
        break;
      }

      default:
        break;
    }
  }

  return converted;
}
