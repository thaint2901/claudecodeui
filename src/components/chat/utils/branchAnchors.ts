/**
 * Fork-anchor matching helpers for the branch switcher.
 *
 * The server stores a fork's anchor (`forkedAtMessageUuid`) as the BARE
 * transcript uuid of the resume-point assistant entry. The Claude normalizer,
 * however, splits an array-content assistant entry into one NormalizedMessage
 * per content part, with ids of the form `<uuid>_<partIndex>` — only
 * string-content messages keep the bare uuid as their id. Matching the
 * switcher against `message.uuid` therefore has to compare base uuids, and
 * has to pick exactly ONE part per turn to hang the switcher on.
 */

/** Strips the normalizer's `_<partIndex>` suffix; bare ids pass through. */
export function baseMessageUuid(id: string): string {
  return id.replace(/_\d+$/, '');
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
