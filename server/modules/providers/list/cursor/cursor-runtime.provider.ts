import type { IProviderRuntime, ProviderRunOptions, ProviderRunWriter } from '@/shared/interfaces.js';

import { abortCursorSession, spawnCursor } from './cursor-cli.js';

/**
 * Execution adapter for Cursor CLI. Delegates 1:1 to cursor-cli.js;
 * explicit method bodies so the JS implementation is checked against the
 * IProviderRuntime signature at this boundary.
 */
export class CursorRuntimeProvider implements IProviderRuntime {
  run(command: string, options: ProviderRunOptions, writer: ProviderRunWriter): Promise<void> {
    return spawnCursor(command, options, writer);
  }

  abort(providerSessionId: string): boolean {
    return abortCursorSession(providerSessionId);
  }
}
