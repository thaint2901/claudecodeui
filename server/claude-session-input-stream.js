// server/claude-session-input-stream.js
/**
 * Push-based AsyncIterable of SDKUserMessage.
 *
 * The SDK's streaming input mode takes an AsyncIterable as `prompt`. While that
 * iterable stays un-ended, the CLI treats input as open — and its background
 * task reaper only sweeps when input is closed. So this object's lifetime IS
 * the lifetime of any background shell the session started.
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
  /** @type {((result: { value: object | undefined, done: boolean }) => void) | null} */
  let waiting = null;
  let closed = false;

  const settleWaiting = (result) => {
    const resolve = waiting;
    waiting = null;
    resolve(result);
  };

  return {
    push(message) {
      if (closed) {
        return;
      }
      if (waiting) {
        settleWaiting({ value: message, done: false });
        return;
      }
      queued.push(message);
    },

    close() {
      if (closed) {
        return;
      }
      closed = true;
      if (waiting) {
        settleWaiting({ value: undefined, done: true });
      }
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
            waiting = resolve;
          });
        },
        return() {
          closed = true;
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}
