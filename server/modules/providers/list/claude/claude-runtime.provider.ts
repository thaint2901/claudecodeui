import type {
  IProviderRuntime,
  IProviderRuntimeApprovals,
  ProviderRunOptions,
  ProviderRunWriter,
} from '@/shared/interfaces.js';

import {
  abortClaudeSDKSession,
  getPendingApprovalsForSession,
  queryClaudeSDK,
  resolveToolApproval,
} from './claude-sdk.js';

/**
 * Execution adapter for Claude (Agent SDK). Delegates 1:1 to claude-sdk.js;
 * explicit method bodies so the JS implementation is checked against the
 * IProviderRuntime signature at this boundary.
 */
export class ClaudeRuntimeProvider implements IProviderRuntime {
  run(command: string, options: ProviderRunOptions, writer: ProviderRunWriter): Promise<void> {
    return queryClaudeSDK(command, options, writer);
  }

  abort(providerSessionId: string): Promise<boolean> {
    // @ts-expect-error -- claude-sdk.js's JSDoc annotates a bare `boolean` return on this async function, so tsc infers `boolean` instead of `Promise<boolean>`.
    return abortClaudeSDKSession(providerSessionId);
  }

  readonly approvals: IProviderRuntimeApprovals = {
    // @ts-expect-error -- resolveToolApproval has no return statement, so tsc infers `void`; `void` is not structurally assignable to the contract's `boolean | undefined`, even though the actual runtime values (`undefined`/no-op) already satisfy it.
    resolve: resolveToolApproval,
    getPendingForSession: getPendingApprovalsForSession,
  };
}
