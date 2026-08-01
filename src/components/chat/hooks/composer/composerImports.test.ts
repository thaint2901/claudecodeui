import test from 'node:test';
import assert from 'node:assert/strict';

// Phase 3 gate: the composer hook's module graph must load under tsx --test.
// If this import ever crashes (ESM interop, e.g. react-syntax-highlighter
// entering the chain), the composer split's test referee is void — fix the
// import chain before extending the split.
test('useChatComposerState module graph loads under tsx --test', async () => {
  const mod = await import('../useChatComposerState.js');
  assert.equal(typeof mod.useChatComposerState, 'function');
});
