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

type BranchSibling = {
  sessionId: string;
  activeLeaf?: boolean;
};

/**
 * Which sibling the `‹ n/total ›` pager is currently sitting on, or -1 when the
 * list can position neither signal (the caller then withholds the pager rather
 * than render a position it cannot justify).
 *
 * The two signals are not interchangeable and must be tried in this order.
 * `sessionId` is what the user is LOOKING AT; `activeLeaf` is what the server
 * last told us. They disagree for as long as a switch is ahead of its
 * `/branches` refetch — the transcript has already moved, the loaded rows still
 * flag the previous sibling — and the branch list is deliberately kept across
 * that window (a cleared list made a transient 500 delete the pager outright).
 *
 * Resolving both in one predicate (`b.sessionId === current || b.activeLeaf`)
 * silently made array ORDER the tie-breaker, so a stale leaf on an earlier
 * sibling beat the exact match on a later one: the pager read `2/3` while
 * version 3 was on screen, and `›` then navigated to the version already shown.
 * If that refetch failed, the list is kept and the wrong position was permanent.
 */
export function pickBranchIndex(
  siblings: readonly BranchSibling[],
  currentSessionId: string | null | undefined,
): number {
  const onScreen = siblings.findIndex((b) => b.sessionId === currentSessionId);
  if (onScreen >= 0) return onScreen;
  return siblings.findIndex((b) => b.activeLeaf);
}

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
 * to the anchor's own last non-tool assistant part when there is none.
 *
 * The reachable fallback triggers are:
 *   - the anchor is the last loaded message (nothing follows it yet);
 *   - the tail after it is hidden — `viewHiddenCount` / `forkHiddenIds` during
 *     an optimistic fork (useChatSessionState.ts);
 *   - an earlier anchor already claimed the prompt that follows.
 *
 * The fallback deliberately skips tool parts: ChatMessagesPane routes grouped
 * tool parts to ToolGroupContainer, which has no switcher slot, so an id
 * pointing there would render nothing at all. Today no tool row even reaches
 * this function with a uuid, but that is an invariant of the renderer rather
 * than of this module — adding `uuid` to a tool row for deep-linking would
 * otherwise delete the control silently.
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

  // Two indexes per anchor, because they answer different questions.
  // `anchorIndexes` is where the forward scan starts — the LAST part of the
  // anchor turn, so the scan cannot re-find the turn's own rows.
  // `anchorFallbacks` is the id to fall back to, and it has to be a part
  // MessageComponent will actually render: ChatMessagesPane routes grouped
  // tool parts to ToolGroupContainer, which has no switcher slot, so an id
  // pointing there renders nothing at all. Excluding tool parts from the
  // fallback and not from `anchorIndexes` is deliberate — dropping such an
  // anchor outright would also lose the switcher when a perfectly good prompt
  // follows it.
  //
  // The `!message.uuid` test is load-bearing rather than defensive: the
  // renderer gives a uuid only to user-text and assistant-text rows
  // (useChatMessages.ts), so every tool, thinking and error row arrives with
  // `uuid: undefined`. Without it `baseMessageUuid` is handed undefined on the
  // first tool call of any session.
  const anchorIndexes = new Map<string, number>();
  const anchorFallbacks = new Map<string, string>();
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.type !== 'assistant' || !message.uuid) continue;
    const base = baseMessageUuid(message.uuid);
    if (!anchors.has(base)) continue;
    anchorIndexes.set(base, index);
    if (!message.isToolUse) anchorFallbacks.set(base, message.uuid);
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

    const fallbackId = anchorFallbacks.get(anchor);
    const resolved = ownerId && !owners.has(ownerId) ? ownerId : fallbackId;
    if (resolved && !owners.has(resolved)) owners.set(resolved, anchor);
  }

  return owners;
}
