import os from 'node:os';
import path from 'node:path';

// ---------------------------
//----------------- OPENCODE SESSION STORAGE UTILITIES ------------
/**
 * Resolves the OpenCode SQLite session database path.
 *
 * OpenCode stores session, message, part, and project metadata in one shared
 * `opencode.db` file under its XDG data directory. Provider readers and
 * synchronizers should use this path for read-only access and should never store
 * it as a deletable transcript path for an individual app session row.
 */
export function getOpenCodeDatabasePath(): string {
  return path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
}

/**
 * Decodes an OpenCode text payload that was persisted as a JSON string literal.
 *
 * OpenCode can store the first user prompt (and other text parts) as `"hello"`
 * instead of `hello`. Used by both the OpenCode session reader (transcript
 * history) and the OpenCode synchronizer (session titling) so a session name or
 * message body never surfaces with surrounding quote characters. Only fully
 * quoted, valid JSON string literals are unwrapped; ordinary prose that merely
 * happens to start/end with a quote is returned untouched.
 */
export function unwrapJsonStringLiteral(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) {
    return value;
  }

  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed === 'string' ? parsed : value;
  } catch {
    return value;
  }
}
