import { setBroadcastHandler } from '@/modules/events/index.js';
import { setLiveRunProbe } from '@/modules/providers/index.js';

import { WS_OPEN_STATE, connectedClients } from './services/websocket-state.service.js';
import { chatRunRegistry } from './services/chat-run-registry.service.js';

export { WS_OPEN_STATE, connectedClients } from './services/websocket-state.service.js';
export { createWebSocketServer } from './services/websocket-server.service.js';
export { chatRunRegistry };

// Registers the one real broadcast handler at module load time. Services
// publish through `@/modules/events/index.js#broadcast` instead of importing
// this module directly, so they never depend on the websocket module (which
// is what let realtime broadcast close several dependency cycles back into
// providers/projects). Wire bytes are unchanged: this is the same
// send-to-all-open-clients loop every prior consumer ran inline.
setBroadcastHandler((message) => {
  const payload = JSON.stringify(message);
  for (const client of connectedClients) {
    if (client.readyState === WS_OPEN_STATE) {
      try {
        client.send(payload);
      } catch (error) {
        console.warn('[Broadcast] Failed to deliver event:', (error as Error).message);
      }
    }
  }
});

// Registers the one real "who is currently running" probe at module load
// time. sessions.service publishes through this seam instead of importing
// this module directly, so it never depends on the websocket module (which
// is what closed the last server-side module dependency cycle).
setLiveRunProbe({
  listRunningRuns: () => chatRunRegistry.listRunningRuns(),
});
