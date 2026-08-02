import type { IProviderRuntime, ProviderRunOptions, ProviderRunWriter } from '@/shared/interfaces.js';

import { abortCodexSession, queryCodex } from './openai-codex.js';

/**
 * Execution adapter for Codex. Delegates 1:1 to openai-codex.js;
 * explicit method bodies so the JS implementation is checked against the
 * IProviderRuntime signature at this boundary.
 */
export class CodexRuntimeProvider implements IProviderRuntime {
  run(command: string, options: ProviderRunOptions, writer: ProviderRunWriter): Promise<void> {
    return queryCodex(command, options, writer);
  }

  abort(providerSessionId: string): boolean {
    return abortCodexSession(providerSessionId);
  }
}
