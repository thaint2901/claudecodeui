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

/**
 * Strips comments so a commented-out line cannot vouch for live code.
 *
 * The first version of the check below filtered raw lines containing
 * `app.use(compression`, which meant this stayed green:
 *   // app.use(compression({ filter: shouldCompress }));   <- disabled while debugging
 *   app.use(compression());
 * i.e. it passed through the exact regression it exists to catch. Quote state
 * is tracked so a `//` inside a string (`'http://…'`) is not mistaken for a
 * comment.
 */
function stripComments(source) {
  let out = '';
  let quote = null;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];
    if (quote) {
      out += char;
      if (char === '\\') { out += next ?? ''; i += 1; continue; }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; out += char; continue; }
    if (char === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    if (char === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 1;
      continue;
    }
    out += char;
  }
  return out;
}

test('server/index.js never mounts compression unfiltered', () => {
  const source = stripComments(readFileSync(SERVER_INDEX, 'utf8'));

  // Asserting the ABSENCE of the broken shape rather than the presence of one
  // exact correct shape: hoisting the middleware to a named binding
  // (`const mw = compression({ filter: shouldCompress }); app.use(mw);`) is
  // behaviour-preserving and must not fail this test, while `compression()`
  // with no arguments must fail it however it is spelled.
  const bareCall = /\bcompression\(\s*\)/.exec(source);
  assert.equal(
    bareCall,
    null,
    'compression() is invoked with no filter — unfiltered, it buffers every SSE stream until '
      + 'it closes, freezing clone progress, session search and /api/agent?stream=true.',
  );

  assert.match(source, /\bcompression\(/, 'server/index.js no longer mounts compression at all');
  assert.match(
    source,
    /filter:\s*shouldCompress/,
    'compression() must be given the shouldCompress filter.',
  );
});
