import assert from 'node:assert/strict';
import test from 'node:test';

import { emitBackgroundTaskEvent } from '@/modules/websocket/services/chat-session-events.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

class FakeConnection {
  readyState = 1;
  frames: Array<Record<string, unknown>> = [];

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }
}

test('emits a background_task frame to open clients', () => {
  connectedClients.clear();
  const open = new FakeConnection();
  const closed = new FakeConnection();
  closed.readyState = 3;
  connectedClients.add(open as never);
  connectedClients.add(closed as never);

  emitBackgroundTaskEvent({
    sessionId: 'app-1',
    taskId: 'bg1',
    status: 'completed',
    outputFile: '/tmp/bg1.output',
    summary: 'sonar finished',
  });

  assert.equal(open.frames.length, 1);
  const frame = open.frames[0];
  assert.equal(frame.kind, 'background_task');
  assert.equal(frame.sessionId, 'app-1');
  assert.equal(frame.taskId, 'bg1');
  assert.equal(frame.status, 'completed');
  assert.equal(frame.outputFile, '/tmp/bg1.output');
  assert.equal(frame.summary, 'sonar finished');
  assert.equal(typeof frame.timestamp, 'string');

  assert.equal(closed.frames.length, 0, 'must skip non-open sockets');
  connectedClients.clear();
});

test('a failing client does not stop delivery to the rest', () => {
  connectedClients.clear();
  const broken = {
    readyState: 1,
    send(): void { throw new Error('socket exploded'); },
  };
  const healthy = new FakeConnection();
  connectedClients.add(broken as never);
  connectedClients.add(healthy as never);

  emitBackgroundTaskEvent({
    sessionId: 'app-2',
    taskId: 'bg2',
    status: 'stopped',
    outputFile: '/tmp/bg2.output',
    summary: 'reaped',
  });

  assert.equal(healthy.frames.length, 1);
  connectedClients.clear();
});
