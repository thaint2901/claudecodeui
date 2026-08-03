/**
 * Wire-level message/event types shared between the backend (`server/`) and
 * frontend (`src/`) realtime chat protocol.
 *
 * This is the single source of truth for `MessageKind`, `GatewayEventKind`,
 * `ServerEventKind`, and `NormalizedMessage`. Both tiers re-export these types
 * from their own tier-local `@/` alias (`server/shared/types.ts`,
 * `src/stores/useSessionStore.ts`) rather than redeclaring them, so the two
 * tiers cannot drift out of sync on the wire contract.
 *
 * Like `shared/networkHosts.js`, this file is imported at runtime (not just
 * for types) — see the helpers at the bottom.
 */

/** Provider identifier carried on every `NormalizedMessage`. */
type WireLLMProvider = 'claude' | 'codex' | 'cursor' | 'opencode';

/**
 * Message/event variants emitted by provider adapters and normalized transports.
 *
 * Keep this union in sync with event kinds produced by provider session adapters.
 */
export type MessageKind =
  | 'text'
  | 'tool_use'
  | 'tool_result'
  | 'thinking'
  | 'stream_delta'
  | 'stream_end'
  | 'error'
  | 'complete'
  | 'status'
  | 'permission_request'
  | 'permission_cancelled'
  | 'session_created'
  | 'interactive_prompt'
  | 'task_notification';

/**
 * Complete set of `kind` values emitted to websocket clients.
 *
 * Every server-to-client websocket frame carries a `kind` from this union.
 * Provider runtimes emit `MessageKind` values; gateway services emit
 * `GatewayEventKind` values.
 */
export type ServerEventKind = MessageKind | GatewayEventKind;

/**
 * Provider-neutral message envelope used in REST responses and realtime channels.
 *
 * Every provider-specific message must be converted into this shape before being
 * emitted outside provider-specific modules.
 */
export type NormalizedMessage = {
  id: string;
  sessionId: string;
  timestamp: string;
  provider: WireLLMProvider;
  kind: MessageKind;
  /**
   * Monotonic per-run sequence number assigned by the chat run registry when a
   * live event is forwarded to the websocket. History messages loaded over
   * REST do not carry it. Clients use it with `chat.subscribe` to replay only
   * the live events they missed across websocket reconnects.
   */
  seq?: number;
  role?: 'user' | 'assistant';
  content?: string;
  /**
   * Optional display-oriented metadata used by providers that need to expose
   * richer transcript artifacts without introducing a brand-new message kind.
   *
   * Current Claude usage:
   * - local slash commands expose parsed command fields
   * - compact summaries are flagged so the UI can treat them differently later
   */
  displayText?: string;
  commandName?: string;
  commandMessage?: string;
  commandArgs?: string;
  isLocalCommand?: boolean;
  isLocalCommandStdout?: boolean;
  isCompactSummary?: boolean;
  images?: Array<{ path?: string; data?: string; name?: string }>;
  toolName?: string;
  toolInput?: unknown;
  toolId?: string;
  toolResult?: { content?: string; isError?: boolean; toolUseResult?: unknown } | null;
  isError?: boolean;
  text?: string;
  tokens?: number;
  canInterrupt?: boolean;
  requestId?: string;
  input?: unknown;
  context?: unknown;
  reason?: string;
  newSessionId?: string;
  status?: string;
  summary?: string;
  tokenBudget?: unknown;
  parentToolUseId?: string;
  toolUseResult?: unknown;
  exitCode?: number;
  actualSessionId?: string;
  isFinal?: boolean;
  aborted?: boolean;
  // Cursor-specific ordering
  sequence?: number;
  rowid?: number;
  [key: string]: unknown;
};

// ---------------------------
//----------------- RUNTIME HELPERS ------------
// This file is imported at runtime (like networkHosts.js), not just for
// types — `isGatewayEventKind` and `assertNever` are real functions.

const GATEWAY_EVENT_KINDS = [
  'chat_subscribed', 'session_upserted', 'branch_created',
  'loading_progress', 'protocol_error', 'session_lock_state_changed',
] as const;

/**
 * Event kinds added by the chat gateway layer on top of provider message kinds.
 *
 * These are app-level realtime events (subscription acks, sidebar deltas,
 * project loading progress, protocol failures, session-lock changes) that are
 * not produced by any provider adapter. Together with `MessageKind` they form
 * the complete set of `kind` values a websocket client can receive, so the
 * frontend only ever needs one kind-based switch.
 */
export type GatewayEventKind = (typeof GATEWAY_EVENT_KINDS)[number];

export function isGatewayEventKind(kind: string): kind is GatewayEventKind {
  return (GATEWAY_EVENT_KINDS as readonly string[]).includes(kind);
}

export function assertNever(x: never): never {
  throw new Error(`Unhandled kind: ${String(x)}`);
}
