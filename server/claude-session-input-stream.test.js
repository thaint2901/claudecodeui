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

  await new Promise((resolve) => setTimeout(resolve, 50));
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
