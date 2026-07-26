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
  isToolUse?: boolean;
};

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

/**
 * Decides which rendered message owns the `‹ n/total ›` switcher for each fork
 * anchor, as a `renderedMessageId -> anchorUuid` map.
 *
 * The anchor itself is an ASSISTANT uuid — the resume point every sibling
 * copies verbatim — so it is the one message a fork point does NOT change.
 * What differs between siblings is the user prompt that follows it. Hanging
 * the control on the anchor therefore paginated the shared message: measured
 * on a real 4-branch cluster, pressing `›` left the attached message identical
 * and rewrote the one below it. It also landed the control in the gutter
 * between two turns (4px from the assistant block above, 16px from the user
 * bubble below, right edge overhanging that bubble by 44px), so neither
 * proximity nor alignment said who owned it.
 *
 * So: resolve each anchor to the first plain user turn after it, and fall back
 * to the anchor's own assistant part when there is none.
 *
 * Two shapes force that fallback, and both must keep rendering something
 * rather than silently dropping the control:
 *   - the anchor is the last loaded message (nothing follows it yet);
 *   - every following user entry is a tool_result (`isToolUse`), which
 *     ChatMessagesPane routes to ToolGroupContainer — a component with no
 *     switcher slot, so an id pointing there renders nothing at all.
 */
export function pickBranchSwitcherOwners(
  messages: readonly AnchorCandidate[],
  anchorUuids: Iterable<string | null | undefined>,
): Map<string, string> {
  const anchors = new Set<string>();
  for (const anchor of anchorUuids) {
    if (anchor) anchors.add(anchor);
  }

  const owners = new Map<string, string>();
  if (anchors.size === 0) return owners;

  // Last part wins: an array-content assistant turn renders as several parts
  // and the switcher belongs at the visual end of that turn.
  const anchorIndexes = new Map<string, number>();
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.type !== 'assistant' || !message.uuid) continue;
    const base = baseMessageUuid(message.uuid);
    if (anchors.has(base)) anchorIndexes.set(base, index);
  }

  // Ascending index order, so when two anchors would claim the same following
  // prompt the earlier one keeps it and the later one falls back to its own
  // assistant part instead of overwriting.
  const ordered = [...anchorIndexes].sort((a, b) => a[1] - b[1]);

  for (const [anchor, anchorIndex] of ordered) {
    let ownerId: string | undefined;
    for (let index = anchorIndex + 1; index < messages.length; index++) {
      const message = messages[index];
      if (message.type === 'user' && message.uuid && !message.isToolUse) {
        ownerId = message.uuid;
        break;
      }
    }

    const fallbackId = messages[anchorIndex].uuid;
    const resolved = ownerId && !owners.has(ownerId) ? ownerId : fallbackId;
    if (resolved && !owners.has(resolved)) owners.set(resolved, anchor);
  }

  return owners;
}
