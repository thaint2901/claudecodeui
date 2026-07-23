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
