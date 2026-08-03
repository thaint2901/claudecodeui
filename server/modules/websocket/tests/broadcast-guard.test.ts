import assert from 'node:assert/strict';
import test from 'node:test';

import { broadcast } from '@/modules/events/index.js';
// Side-effect import: registers the real send-to-all-open-clients handler
// (see server/modules/websocket/index.ts) so this test exercises the exact
// production handler, not a stand-in.
import '@/modules/websocket/index.js';
import { connectedClients, WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';

/** Minimal stand-in for a websocket connection, mirroring chat-run-registry.test.ts's FakeConnection. */
class FakeConnection {
  readyState = WS_OPEN_STATE;
  frames: Array<Record<string, unknown>> = [];

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }
}

/** A client whose socket throws on send, e.g. closed between the readyState check and send(). */
class ThrowingConnection {
  readyState = WS_OPEN_STATE;

  send(): void {
    throw new Error('socket closed mid-send');
  }
}

test('one throwing client does not block delivery to the others', () => {
  connectedClients.clear();

  const throwing = new ThrowingConnection();
  const healthyBefore = new FakeConnection();
  const healthyAfter = new FakeConnection();

  // Iteration order of a Set is insertion order, so the throwing client sits
  // between two healthy ones to prove neighbors on both sides still receive.
  connectedClients.add(healthyBefore as never);
  connectedClients.add(throwing as never);
  connectedClients.add(healthyAfter as never);

  try {
    const payload = { kind: 'status' };
    assert.doesNotThrow(() => broadcast(payload));

    assert.equal(healthyBefore.frames.length, 1);
    assert.deepEqual(healthyBefore.frames[0], payload);
    assert.equal(healthyAfter.frames.length, 1);
    assert.deepEqual(healthyAfter.frames[0], payload);
  } finally {
    connectedClients.clear();
  }
});
