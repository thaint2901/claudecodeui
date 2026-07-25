import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { once } from 'node:events';

import compression from 'compression';
import express from 'express';

import { shouldCompress } from './compression-filter.js';

/**
 * The unit tests next door prove `shouldCompress` returns the right booleans.
 * They stayed green through the original bug, because the bug was never in the
 * predicate — it was that `server/index.js` mounted `compression()` with no
 * filter at all, and gzip then held every SSE event until the stream closed.
 *
 * These two tests cover the half a predicate test cannot: that the filter
 * actually changes wire behaviour, and that the server is actually wired to
 * use it. Reverting `app.use(compression({ filter: shouldCompress }))` back to
 * `app.use(compression())` turns the second one red.
 */

const SERVER_INDEX = fileURLToPath(new URL('../index.js', import.meta.url));

/** Boots a throwaway express app and returns its base URL plus a close(). */
async function startApp(configure) {
  const app = express();
  configure(app);
  const server = http.createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('the SSE exemption survives a real request through real middleware', async (t) => {
  const app = await startApp((instance) => {
    instance.use(compression({ filter: shouldCompress }));
    instance.get('/events', (req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.write('data: {"n":1}\n\n');
      // A second event after a tick: with the filter missing, zlib buffers
      // both and the client sees nothing until the response ends.
      setTimeout(() => {
        res.write('data: {"n":2}\n\n');
        res.end();
      }, 120);
    });
    instance.get('/json', (req, res) => {
      // Comfortably past compression's 1kb default threshold.
      res.json({ filler: 'x'.repeat(4096) });
    });
  });
  t.after(() => app.close());

  const sse = await fetch(`${app.base}/events`, { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(sse.headers.get('content-encoding'), null, 'SSE must not be content-encoded');

  // Read the first chunk and confirm it arrives before the stream ends.
  const reader = sse.body.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /data: \{"n":1\}/);
  await reader.cancel();

  const json = await fetch(`${app.base}/json`, { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(json.headers.get('content-encoding'), 'gzip', 'ordinary JSON must stay compressed');
});

test('server/index.js mounts compression with the SSE filter', () => {
  // Narrow to the mount line before asserting: matching against the whole file
  // makes a failure dump 55k characters of source instead of the one line that
  // is wrong.
  const mountLines = readFileSync(SERVER_INDEX, 'utf8')
    .split('\n')
    .filter((line) => line.includes('app.use(compression'))
    .join('\n')
    .trim();

  assert.notEqual(mountLines, '', 'server/index.js no longer mounts compression at all');
  assert.match(
    mountLines,
    /compression\(\s*\{[^}]*filter:\s*shouldCompress[^}]*\}\s*\)/,
    'compression() must be mounted with the shouldCompress filter — unfiltered, it buffers '
      + `every SSE stream until it closes. Found: ${mountLines}`,
  );
});
