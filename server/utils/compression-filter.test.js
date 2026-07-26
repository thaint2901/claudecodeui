import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldCompress } from './compression-filter.js';

/**
 * Minimal stand-ins for the express req/res pair. `compression.filter` only
 * reads `Content-Type` off the response, so a getHeader shim is enough.
 */
const reqFor = (headers = {}) => ({ headers: { 'accept-encoding': 'gzip', ...headers } });
const resFor = (contentType) => ({
  getHeader: (name) => (name.toLowerCase() === 'content-type' ? contentType : undefined),
});

test('SSE responses are never compressed', () => {
  assert.equal(shouldCompress(reqFor(), resFor('text/event-stream')), false);
});

test('SSE responses are exempt even with a charset parameter', () => {
  assert.equal(shouldCompress(reqFor(), resFor('text/event-stream; charset=utf-8')), false);
});

test('ordinary JSON responses stay compressed', () => {
  assert.equal(shouldCompress(reqFor(), resFor('application/json; charset=utf-8')), true);
});

test('the JS bundle stays compressed', () => {
  assert.equal(shouldCompress(reqFor(), resFor('application/javascript')), true);
});

test('images are left alone, as compression.filter already decides', () => {
  assert.equal(shouldCompress(reqFor(), resFor('image/png')), false);
});

test('a response with no Content-Type defers to compression.filter', () => {
  // compression.filter treats an unknown type as not compressible; the point
  // of this case is that the SSE guard must not throw on a missing header.
  assert.doesNotThrow(() => shouldCompress(reqFor(), resFor(undefined)));
});
