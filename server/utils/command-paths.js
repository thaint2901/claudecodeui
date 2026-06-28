import os from "os";
import path from "path";

/**
 * Strips a leading YAML frontmatter block from a markdown string without a YAML
 * parser. Used only as a fallback when `parseFrontMatter` throws, so a malformed
 * block (e.g. `argument-hint: [x] (y)`, which js-yaml reads as a flow sequence
 * and then chokes on the trailing `(y)`) never drops the command from the
 * palette. The runtime's dispatcher reads the file itself; cloudcli only needs
 * the body for a heading/first-line description.
 *
 * @param {string} content - Markdown with an optional leading `---` frontmatter block.
 * @returns {string} The body with frontmatter removed, or the original content if
 *   there is no opening fence or no closing fence.
 */
export function stripFrontMatter(content) {
  if (typeof content !== "string") {
    return "";
  }
  if (!content.startsWith("---")) {
    return content;
  }
  // Skip the opening `---` line.
  const afterOpen = content.slice(content.indexOf("\n") + 1);
  // Find the next line that is exactly `---` (the closing fence).
  const closeMatch = afterOpen.match(/\n---\s*(?:\r?\n|$)/);
  if (!closeMatch) {
    return content;
  }
  return afterOpen.slice(closeMatch.index + closeMatch[0].length);
}

/**
 * Per-provider command roots. Each runtime reads its own native command
 * directory (Claude: `.claude/commands/`; OpenCode: `.opencode/commands/` +
 * `~/.config/opencode/commands/`) — cloudcli surfaces only the set the active
 * runtime can actually dispatch. Unlisted providers fall back to Claude's layout.
 *
 * @param {string} provider - One of the MODEL_PROVIDERS values ("claude", "opencode", ...).
 * @param {string|null|undefined} projectPath - Absolute project path, or null when
 *   no project is selected.
 * @returns {{ userDir: string, projectDir: string|null }} Directory paths for the
 *   user-level and project-level command roots.
 */
export function providerCommandDirs(provider, projectPath) {
  const homeDir = os.homedir();

  if (provider === "opencode") {
    return {
      userDir: path.join(homeDir, ".config", "opencode", "commands"),
      projectDir: projectPath
        ? path.join(projectPath, ".opencode", "commands")
        : null,
    };
  }

  return {
    userDir: path.join(homeDir, ".claude", "commands"),
    projectDir: projectPath
      ? path.join(projectPath, ".claude", "commands")
      : null,
  };
}