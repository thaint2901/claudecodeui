/**
 * Process-lifetime cache of the Claude Code CLI's built-in slash commands.
 *
 * The set of built-in commands is a property of the installed Claude Code
 * binary, not of any one conversation, so a single module-level cache is
 * correct: every session's `system/init` message opportunistically refreshes
 * it (self-healing after a CLI upgrade — no server restart needed beyond the
 * next session). Names arrive WITHOUT the leading slash (e.g. "clear").
 *
 * Dependency-free on purpose: testable with plain `node --test`.
 */

/** Descriptions for commonly used built-ins; anything absent gets a generic fallback. */
const KNOWN_DESCRIPTIONS = {
  clear: 'Start a new conversation with empty context',
  compact: 'Free up context by summarizing the conversation',
  context: 'Visualize current context usage',
  usage: 'Show plan usage limits',
  cost: 'Show token usage information',
  init: 'Initialize the project with a CLAUDE.md guide',
  review: 'Review a pull request',
  insights: 'Generate a report analyzing your Claude Code sessions',
  goal: 'Set a goal for Claude to work toward',
  fork: 'Copy the conversation into a new background session',
  subtask: 'Hand a side task to a subagent that reports back here',
};

const FALLBACK_DESCRIPTION = 'Claude Code built-in command';

let cachedNames = [];

export function setClaudeBuiltinCommands(names) {
  if (!Array.isArray(names)) {
    return;
  }
  cachedNames = names.filter((name) => typeof name === 'string' && name.length > 0);
}

export function getClaudeBuiltinCommandEntries(excludeNames = []) {
  const excluded = new Set(excludeNames);
  return cachedNames
    .map((name) => `/${name}`)
    .filter((slashName) => !excluded.has(slashName))
    .map((slashName) => ({
      name: slashName,
      description: KNOWN_DESCRIPTIONS[slashName.slice(1)] || FALLBACK_DESCRIPTION,
      namespace: 'claude-builtin',
      metadata: { type: 'claude-builtin' },
    }));
}
