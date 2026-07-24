import type { ChatMessage } from '../types/types';

/**
 * Best-effort attribution of a permission request to the subagent that
 * triggered it. The SDK's canUseTool callback carries no parent id, but the
 * child tool_use always streams into the transcript BEFORE its approval is
 * requested — so the newest incomplete subagent with a result-less child of
 * the same tool name is the requester.
 */
export function attributePermissionToSubagent(
  messages: ChatMessage[],
  toolName: string,
): { description: string } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message.isSubagentContainer || !message.subagentState || message.subagentState.isComplete) {
      continue;
    }
    const hasPendingCall = message.subagentState.childTools.some(
      (child) => child.toolName === toolName && !child.toolResult,
    );
    if (!hasPendingCall) {
      continue;
    }
    let description = 'subagent';
    try {
      const input = typeof message.toolInput === 'string' ? JSON.parse(message.toolInput) : message.toolInput;
      description = input?.description || input?.subagent_type || 'subagent';
    } catch { /* keep fallback */ }
    return { description };
  }
  return null;
}
