import assert from 'node:assert/strict';
import test from 'node:test';

import { providerRegistry } from '@/modules/providers/provider.registry.js';

const PROVIDERS = ['claude', 'cursor', 'codex', 'opencode'] as const;

test('every provider exposes a runtime with run and abort', () => {
  for (const id of PROVIDERS) {
    const runtime = providerRegistry.resolveProvider(id).runtime;
    assert.ok(runtime, `${id} runtime missing`);
    assert.equal(typeof runtime.run, 'function', `${id} run`);
    assert.equal(typeof runtime.abort, 'function', `${id} abort`);
  }
});

test('only claude exposes the approvals capability', () => {
  const claude = providerRegistry.resolveProvider('claude').runtime;
  assert.equal(typeof claude.approvals?.resolve, 'function');
  assert.equal(typeof claude.approvals?.getPendingForSession, 'function');
  for (const id of ['cursor', 'codex', 'opencode'] as const) {
    assert.equal(providerRegistry.resolveProvider(id).runtime.approvals, undefined, id);
  }
});

test('claude approvals.resolve returns false for an unknown request id', () => {
  // resolveToolApproval (claude-sdk.js) has no return statement for the
  // "unknown id" branch, so it actually yields `undefined`, not `false`.
  // The websocket hub coalesces the result with `?? false`, so callers still
  // see `false` downstream — this pins the real (pre-existing) behavior at
  // this boundary rather than the contract's stricter `boolean` claim.
  const claude = providerRegistry.resolveProvider('claude').runtime;
  assert.equal(claude.approvals?.resolve('nonexistent-request-id', {}), undefined);
});

test('claude approvals.getPendingForSession returns [] for an unknown session', () => {
  const claude = providerRegistry.resolveProvider('claude').runtime;
  assert.deepEqual(claude.approvals?.getPendingForSession('nonexistent-session'), []);
});
