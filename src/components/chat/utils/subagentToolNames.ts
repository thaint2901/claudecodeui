/**
 * Claude Code renamed its subagent-dispatch tool from `Task` to `Agent`.
 * Official agent-sdk docs recommend matching both names for compatibility;
 * old persisted transcripts still carry `Task`.
 */
export const SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set(['Agent', 'Task']);

export function isSubagentToolName(toolName: string | undefined): boolean {
  return typeof toolName === 'string' && SUBAGENT_TOOL_NAMES.has(toolName);
}
