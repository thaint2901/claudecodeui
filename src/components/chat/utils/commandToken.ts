/**
 * Splits a leading slash-command token off the composer text, but only when
 * it exactly matches a known command name — unknown "/words" stay plain so
 * the highlight never lies about what will dispatch.
 */
export function matchLeadingCommand(
  text: string,
  commandNames: ReadonlySet<string>,
): { command: string; rest: string } | null {
  const match = /^(\/[^\s]+)([\s\S]*)$/.exec(text);
  if (!match) {
    return null;
  }
  if (!commandNames.has(match[1])) {
    return null;
  }
  return { command: match[1], rest: match[2] };
}
