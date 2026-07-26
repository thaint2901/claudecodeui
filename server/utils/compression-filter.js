import compression from 'compression';

/**
 * Response filter for the global `compression()` middleware.
 *
 * Server-Sent Events must never be compressed here. `compressible` classifies
 * `text/event-stream` as compressible (it has no mime-db entry, so it falls
 * through to the generic `^text/` rule), and none of this server's SSE writers
 * call `res.flush()`. With zlib's default `Z_NO_FLUSH` that means every small
 * `data: {...}\n\n` write lands in the compressor's buffer instead of the
 * socket, and the whole stream is released in one chunk when the response
 * ends — measured as five events, emitted 300ms apart, arriving together at
 * close. Progress bars freeze, incremental search results never appear, and
 * `/api/agent?stream=true` stops streaming for external callers.
 *
 * Everything else still goes through `compression.filter`, so ordinary JSON
 * and the static bundle keep their gzip.
 */
export function shouldCompress(req, res) {
  const contentType = res.getHeader('Content-Type');
  if (typeof contentType === 'string' && contentType.includes('text/event-stream')) {
    return false;
  }

  return compression.filter(req, res);
}
