# Capability: Connection Lifecycle

## Description

Manages the connect / disconnect / restart lifecycle of the PTY connection, including the WebSocket heartbeat that survives reverse-proxy idle timeouts.

## Actors

- **End-user developer** — Clicks Connect, Disconnect, or Restart.
- **The shell WebSocket service** — Manages the PTY process.
- **The WebSocket hub** — Sends pings every 30 seconds.

## Trigger

- The user clicks **Connect** on the connection overlay.
- The user clicks **Disconnect** to close the PTY.
- The user clicks **Restart** to close and reopen the PTY.
- The user navigates away (disconnect).

## Flow (Connect)

1. The connection overlay is shown when the shell is not connected.
2. The user clicks **Connect**.
3. The frontend opens a WebSocket to `/shell`.
4. The shell service spawns a PTY and starts streaming.
5. The connection overlay disappears; the terminal is live.

## Flow (Disconnect)

1. The user clicks **Disconnect** (or navigates away).
2. The frontend closes the WebSocket.
3. The shell service kills the PTY (SIGTERM, then SIGKILL after a grace period).
4. The connection overlay reappears.

## Flow (Restart)

1. The user clicks **Restart**.
2. The shell service kills the existing PTY and spawns a new one.
3. The terminal clears and the new session begins.

## Flow (Heartbeat)

- The WebSocket hub sends a ping every 30 seconds to keep the connection alive through reverse proxies (which would otherwise close idle connections).

## Output

- A reliable PTY lifecycle that survives disconnects, restarts, and idle timeouts.

## Technical Mapping

- **Frontend overlay:** `src/components/shell/view/subcomponents/ShellConnectionOverlay.tsx`
- **Frontend empty state:** `src/components/shell/view/subcomponents/ShellEmptyState.tsx`
- **Frontend minimal view:** `src/components/shell/view/subcomponents/ShellMinimalView.tsx`
- **Backend service:** `server/modules/websocket/services/shell-websocket.service.ts`
- **Backend hub:** `server/modules/websocket/services/websocket-server.service.ts` (heartbeat)

## Dependencies

- **Terminal/Shell** — The underlying PTY.
- **Authentication & Security** — WebSocket token auth.
