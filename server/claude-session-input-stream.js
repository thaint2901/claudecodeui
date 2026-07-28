// server/claude-session-input-stream.js
/**
 * Push-based AsyncIterable of SDKUserMessage.
 *
 * The SDK's streaming input mode takes an AsyncIterable as `prompt`. While that
 * iterable stays un-ended, the CLI treats input as open — and its background
 * task reaper only sweeps when input is closed. So this object's lifetime IS
 * the lifetime of any background shell the session started.
 *
 * `next()` can be called again before a previous call has settled (e.g. two
 * overlapping consumers, or a drain loop racing a `return()` from the SDK
 * tearing down the prompt iterator). Each such call gets its own resolver
 * queued in `waiters`, FIFO. `close()` and `return()` must settle every
 * queued resolver — not just the most recent one — or an earlier caller's
 * `next()` promise hangs forever.
 *
 * @returns {{
 *   push: (message: object) => void,
 *   close: () => void,
 *   readonly closed: boolean,
 *   [Symbol.asyncIterator]: () => AsyncIterator<object>
 * }}
 */
export function createInputStream() {
  /** @type {object[]} */
  const queued = [];
  /** @type {((result: { value: object | undefined, done: boolean }) => void)[]} */
  const waiters = [];
  let closed = false;

  const settleAllWaiters = (result) => {
    while (waiters.length > 0) {
      const resolve = waiters.shift();
      resolve(result);
    }
  };

  return {
    push(message) {
      if (closed) {
        return;
      }
      if (waiters.length > 0) {
        const resolve = waiters.shift();
        resolve({ value: message, done: false });
        return;
      }
      queued.push(message);
    },

    close() {
      if (closed) {
        return;
      }
      closed = true;
      settleAllWaiters({ value: undefined, done: true });
    },

    get closed() {
      return closed;
    },

    [Symbol.asyncIterator]() {
      return {
        next() {
          if (queued.length > 0) {
            return Promise.resolve({ value: queued.shift(), done: false });
          }
          if (closed) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise((resolve) => {
            waiters.push(resolve);
          });
        },
        return() {
          closed = true;
          settleAllWaiters({ value: undefined, done: true });
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}
