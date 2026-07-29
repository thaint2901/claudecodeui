// server/claude-session-input-stream.test.js
import assert from 'node:assert/strict';
import test from 'node:test';

import { createInputStream } from './claude-session-input-stream.js';

const msg = (text) => ({
  type: 'user',
  message: { role: 'user', content: text },
  parent_tool_use_id: null,
});

test('yields messages pushed before iteration starts', async () => {
  const stream = createInputStream();
  stream.push(msg('one'));
  stream.push(msg('two'));
  stream.close();

  const seen = [];
  for await (const m of stream) {
    seen.push(m.message.content);
  }

  assert.deepEqual(seen, ['one', 'two']);
});

test('waits for a push instead of ending, then resumes', async () => {
  const stream = createInputStream();
  const iterator = stream[Symbol.asyncIterator]();

  const pending = iterator.next();
  let settled = false;
  void pending.then(() => { settled = true; });

  // Microtasks, not a wall-clock sleep. Every route by which this promise could
  // settle — `close()`, `return()`, a `push` — resolves it through the microtask
  // queue and never through a timer, so flushing that queue is a COMPLETE check
  // rather than a guess that 50 ms is long enough. A 50 ms sleep also cannot fail
  // fast: it pays the wait even when the code is correct, which is what the pool's
  // close-policy tests were converted away from.
  for (let tick = 0; tick < 50; tick += 1) {
    await Promise.resolve();
  }
  assert.equal(settled, false, 'must not end just because the queue is empty');

  stream.push(msg('late'));
  const result = await pending;
  assert.equal(result.done, false);
  assert.equal(result.value.message.content, 'late');
});

test('close() ends a waiting iterator', async () => {
  const stream = createInputStream();
  const iterator = stream[Symbol.asyncIterator]();
  const pending = iterator.next();

  stream.close();

  assert.deepEqual(await pending, { value: undefined, done: true });
  assert.equal(stream.closed, true);
});

test('push after close is ignored', async () => {
  const stream = createInputStream();
  stream.close();
  stream.push(msg('ignored'));

  const seen = [];
  for await (const m of stream) {
    seen.push(m);
  }
  assert.deepEqual(seen, []);
});

test('two overlapping next() calls both settle, in FIFO order, when two messages are pushed', async () => {
  const stream = createInputStream();
  const iterator = stream[Symbol.asyncIterator]();

  const first = iterator.next();
  const second = iterator.next();

  stream.push(msg('one'));
  stream.push(msg('two'));

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.done, false);
  assert.equal(firstResult.value.message.content, 'one');
  assert.equal(secondResult.done, false);
  assert.equal(secondResult.value.message.content, 'two');
});

test('two overlapping next() calls both settle with done: true when close() is called', async () => {
  const stream = createInputStream();
  const iterator = stream[Symbol.asyncIterator]();

  const first = iterator.next();
  const second = iterator.next();

  stream.close();

  assert.deepEqual(await first, { value: undefined, done: true });
  assert.deepEqual(await second, { value: undefined, done: true });
});

test('a pending next() settles when return() is called on the iterator', async () => {
  const stream = createInputStream();
  const iterator = stream[Symbol.asyncIterator]();

  const pending = iterator.next();
  const returnResult = await iterator.return();

  assert.deepEqual(await pending, { value: undefined, done: true });
  assert.deepEqual(returnResult, { value: undefined, done: true });
  assert.equal(stream.closed, true);
});
