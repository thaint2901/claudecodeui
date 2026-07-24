/**
 * Fork-anchor matching helpers for the branch switcher and edit-prompt flow.
 *
 * The server stores a fork's anchor (`forkedAtMessageUuid`) as the BARE
 * transcript uuid, and `findForkResumePoint` matches the edited prompt by
 * bare uuid too. The Claude normalizer, however, splits an array-content
 * entry into one NormalizedMessage per content part, suffixing the bare uuid
 * (claude-sessions.provider.ts):
 *   - assistant parts:        `<uuid>_<partIndex>`
 *   - user text parts:        `<uuid>_text_<partIndex>` or `<uuid>_text`
 *   - user tool results:      `<uuid>_tr_<toolUseId>`
 *   - image-only user turns:  `<uuid>_images`
 * Only string-content messages keep the bare uuid. Anything comparing a
 * rendered `message.uuid` against a transcript uuid must strip these first.
 * (Bare uuids are hex+hyphens, so none of the suffix patterns can false-match
 * inside one; the `claude_<uuid>` fallback ids are equally safe.)
 *
 * The server mirrors this strip in chat-websocket.service.ts
 * (`normalizeEditAtMessageUuid`) — keep the two in sync.
 */

/** Strips the normalizer's part suffix; bare ids pass through. */
export function baseMessageUuid(id: string): string {
  return id.replace(/_(?:tr_.+|text(?:_\d+)?|images|\d+)$/, '');
}

type AnchorCandidate = {
  uuid?: string;
  type: string;
};

/**
 * Picks, for every anchor uuid, the single message id that should render the
 * branch switcher: the LAST 'assistant'-typed message whose base uuid equals
 * the anchor. Assistant text parts are the only ones routed to
 * MessageComponent (tool parts render via ToolGroupContainer, which has no
 * switcher slot), and the last part puts the switcher at the visual end of
 * the turn.
 */
/**
 * The uuid of the conversation's FIRST user message, for hiding the
 * edit-prompt affordance on it: editing the first prompt has no preceding
 * assistant turn to anchor `resumeSessionAt` on, so the SDK would copy the
 * FULL history into the branch (spike-verified) — wrong semantics for "edit".
 * The server rejects such forks too; hiding the button prevents the dead end.
 *
 * Pagination-aware: while earlier history is still unloaded
 * (`hasMoreMessages`), NONE of the loaded messages can be the first one, so
 * this returns null (everything stays editable). Returns the rendered
 * (possibly part-suffixed) uuid so callers can compare it to `message.uuid`
 * directly.
 */
export function firstUserMessageUuid(
  messages: readonly AnchorCandidate[],
  hasMoreMessages: boolean,
): string | null {
  if (hasMoreMessages) return null;
  for (const message of messages) {
    if (message.type === 'user' && message.uuid) {
      return message.uuid;
    }
  }
  return null;
}

export function pickBranchAnchorMessageIds(
  messages: readonly AnchorCandidate[],
  anchorUuids: Iterable<string | null | undefined>,
): Map<string, string> {
  const anchors = new Set<string>();
  for (const anchor of anchorUuids) {
    if (anchor) anchors.add(anchor);
  }

  const chosen = new Map<string, string>();
  if (anchors.size === 0) return chosen;

  for (const message of messages) {
    if (message.type !== 'assistant' || !message.uuid) continue;
    const base = baseMessageUuid(message.uuid);
    if (anchors.has(base)) {
      // Later parts overwrite earlier ones — the last match wins.
      chosen.set(base, message.uuid);
    }
  }

  return chosen;
}
