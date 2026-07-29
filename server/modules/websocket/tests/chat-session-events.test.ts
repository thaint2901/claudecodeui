import assert from 'node:assert/strict';
import test from 'node:test';

import { emitBackgroundTaskEvent } from '@/modules/websocket/services/chat-session-events.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

class FakeConnection {
  readyState = 1;
  frames: Array<Record<string, unknown>> = [];
  userId: string | number | null;

  constructor(userId: string | number | null = null) {
    this.userId = userId;
  }

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
    userId: 7,
    send(): void { throw new Error('socket exploded'); },
  };
  const healthy = new FakeConnection(7);
  const closed = new FakeConnection(7);
  closed.readyState = 3;
  connectedClients.add(broken as never);
  connectedClients.add(healthy as never);
  connectedClients.add(closed as never);

  emitBackgroundTaskEvent({
    sessionId: 'app-2',
    taskId: 'bg2',
    status: 'stopped',
    outputFile: '/tmp/bg2.output',
    summary: 'reaped',
    ownerUserId: 7,
  });

  assert.equal(healthy.frames.length, 1);
  assert.equal(closed.frames.length, 0, 'a socket that is not open must be skipped, not sent to');
  connectedClients.clear();
});

test('a settled task reaches only the connections of the user whose turn started it', () => {
  connectedClients.clear();
  const ownerTab = new FakeConnection(1);
  const ownersSecondTab = new FakeConnection(1);
  const otherUser = new FakeConnection(2);
  connectedClients.add(ownerTab as never);
  connectedClients.add(ownersSecondTab as never);
  connectedClients.add(otherUser as never);

  emitBackgroundTaskEvent({
    sessionId: 'app-3',
    taskId: 'bg3',
    status: 'completed',
    outputFile: '/home/alice/.claude/tasks/bg3.output',
    summary: 'sonar finished',
    ownerUserId: 1,
  });

  assert.equal(ownerTab.frames.length, 1);
  assert.equal(ownersSecondTab.frames.length, 1, 'every tab of the owner still gets it');
  assert.equal(
    otherUser.frames.length,
    0,
    'another user must not receive the task text or the host output path',
  );
  connectedClients.clear();
});

test('a task whose owner is unknown falls back to a broadcast and logs the reason once', (t) => {
  connectedClients.clear();
  const warn = t.mock.method(console, 'warn', () => {});
  const first = new FakeConnection(1);
  const second = new FakeConnection(2);
  const third = new FakeConnection(null);
  connectedClients.add(first as never);
  connectedClients.add(second as never);
  connectedClients.add(third as never);

  emitBackgroundTaskEvent({
    sessionId: 'app-4',
    taskId: 'bg4',
    status: 'failed',
    summary: 'process died',
  });

  assert.equal(first.frames.length, 1, 'failing closed would drop the owner\'s own notification');
  assert.equal(second.frames.length, 1);
  assert.equal(third.frames.length, 1);

  const fallbackWarnings = warn.mock.calls.filter((call) =>
    typeof call.arguments[0] === 'string' && (call.arguments[0] as string).includes('unknown owner'),
  );
  assert.equal(fallbackWarnings.length, 1, 'logged once per event, not once per client');
  connectedClients.clear();
});

test('an owner with no open connection simply gets nothing — no cross-user consolation prize', () => {
  connectedClients.clear();
  const otherUser = new FakeConnection(2);
  connectedClients.add(otherUser as never);

  emitBackgroundTaskEvent({
    sessionId: 'app-5',
    taskId: 'bg5',
    status: 'completed',
    summary: 'finished while the owner was away',
    ownerUserId: 1,
  });

  assert.equal(otherUser.frames.length, 0);
  connectedClients.clear();
});

test('an emit with no app session id never reaches the wire', (t) => {
  connectedClients.clear();
  const warn = t.mock.method(console, 'warn', () => {});
  const client = new FakeConnection(1);
  connectedClients.add(client as never);

  // A REST-originated run (server/routes/agent.js, server/routes/git.js) has no
  // app-session row, so the pool key it emits under is a provider-native id or a
  // one-shot request id. The frontend would write a transcript row into a store
  // bucket that is not a real session.
  emitBackgroundTaskEvent({
    sessionId: null,
    taskId: 'bg6',
    status: 'completed',
    outputFile: '/tmp/bg6.output',
    summary: 'a REST one-shot finished',
    ownerUserId: 1,
  });

  assert.equal(client.frames.length, 0);
  const dropWarnings = warn.mock.calls.filter((call) =>
    typeof call.arguments[0] === 'string' && (call.arguments[0] as string).includes('no app session id'),
  );
  assert.equal(dropWarnings.length, 1, 'the drop must be visible in the log, not silent');
  connectedClients.clear();
});
