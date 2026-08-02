import type { IProviderRuntime, ProviderRunOptions, ProviderRunWriter } from '@/shared/interfaces.js';

import { abortOpenCodeSession, spawnOpenCode } from './opencode-cli.js';

/**
 * Execution adapter for OpenCode. Delegates 1:1 to opencode-cli.js;
 * explicit method bodies so the JS implementation is checked against the
 * IProviderRuntime signature at this boundary.
 */
export class OpenCodeRuntimeProvider implements IProviderRuntime {
  run(command: string, options: ProviderRunOptions, writer: ProviderRunWriter): Promise<void> {
    return spawnOpenCode(command, options, writer);
  }

  abort(providerSessionId: string): boolean {
    return abortOpenCodeSession(providerSessionId);
  }
}
