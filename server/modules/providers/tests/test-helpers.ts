import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';

/**
 * Redirects `os.homedir()` to a fake directory for the duration of a test.
 * This app's own provider code (`import os from 'node:os'` then
 * `os.homedir()` at call time) observes this reassignment.
 */
export const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as any).homedir = () => nextHomeDir;
  return () => {
    (os as any).homedir = original;
  };
};

/**
 * `renameSession()` from `@anthropic-ai/claude-agent-sdk` resolves its config
 * directory via `process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), '.claude')`
 * using a named `import { homedir }` that does NOT observe `patchHomeDir`'s
 * reassignment of `os.homedir`. Tests that exercise `writeBackCustomName`
 * must also set `CLAUDE_CONFIG_DIR` to the same fake `.claude` directory.
 */
export const patchClaudeConfigDir = (fakeHomeDir: string) => {
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = path.join(fakeHomeDir, '.claude');
  return () => {
    if (previous === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previous;
    }
  };
};

export async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-provider-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}
