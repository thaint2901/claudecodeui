/**
 * Leaf broadcast seam (imports nothing from other modules).
 *
 * Services publish app-level realtime payloads here; the websocket hub
 * registers the one real handler at startup. Before registration,
 * broadcast() is a silent no-op — identical to today's "zero connected
 * clients" behavior, never queued, never thrown.
 */
type BroadcastHandler = (message: unknown) => void;

let broadcastHandler: BroadcastHandler | null = null;

export function setBroadcastHandler(handler: BroadcastHandler): void {
  broadcastHandler = handler;
}

export function broadcast(message: unknown): void {
  if (!broadcastHandler) return;
  broadcastHandler(message);
}

/** Test-only: clears the registered handler. */
export function _resetForTest(): void {
  broadcastHandler = null;
}
