import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../../../shared/view/ui';

/**
 * Marks the pager root with the fork anchor it pages. The switch controller
 * re-finds the pager through this after the swap has replaced it, so the two
 * attributes below are contract, not decoration.
 */
export const PAGER_ANCHOR_ATTRIBUTE = 'data-branch-pager';
/** Marks each chevron with the direction it moves in. */
export const PAGER_ARROW_ATTRIBUTE = 'data-branch-arrow';

/**
 * The two things about a press that are only knowable from the originating
 * event, snapshotted before anything awaits.
 */
function describePress(event: ReactMouseEvent<HTMLButtonElement>) {
  return {
    keyboard: event.detail === 0,
    pager: event.currentTarget.closest(`[${PAGER_ANCHOR_ATTRIBUTE}]`) as HTMLElement | null,
  };
}

export type BranchSwitchMeta = {
  /** Fork anchor this pager belongs to, so the caller can re-find it after the swap. */
  anchor: string;
  direction: 'prev' | 'next';
  /** 1-based position the switch is moving TO, for the announcement. */
  targetIndex: number;
  total: number;
  /**
   * Whether the press came from the keyboard. A click synthesised by Enter or
   * Space carries `detail === 0`; a real pointer click carries the click count.
   * Captured here because it is only knowable from the originating event, and
   * only the keyboard path is allowed to move focus after the swap.
   */
  keyboard: boolean;
  /**
   * The pager the press came from. The caller re-checks, once the switch
   * resolves, that focus is still inside it — otherwise the user has moved on
   * and their focus is not ours to take.
   */
  pager: HTMLElement | null;
};

type BranchSwitcherProps = {
  /** 1-based index of the branch currently displayed at this fork point. */
  current: number;
  total: number;
  /** Fork anchor uuid — identifies this pager across a branch swap. */
  anchor: string;
  /** Sibling ids to move to, or undefined at either end of the list. */
  prevSessionId?: string;
  nextSessionId?: string;
  /**
   * Takes the target id rather than two ready-made callbacks: the caller
   * renders this once per fork anchor, and per-anchor arrow props would hand
   * every message row a fresh identity on each render.
   */
  onSwitch: (sessionId: string | undefined, meta: BranchSwitchMeta) => void;
};

export function BranchSwitcher({
  current,
  total,
  anchor,
  prevSessionId,
  nextSessionId,
  onSwitch,
}: BranchSwitcherProps) {
  const { t } = useTranslation(['chat', 'fork']);

  const atStart = current <= 1;
  const atEnd = current >= total;

  // `disabled` would drop focus to <body> the moment the last press lands on
  // the end of the list, forcing a keyboard user to tab back from the top of
  // the page (WCAG 2.4.3). `aria-disabled` keeps the control focusable and
  // announced as unavailable, and the handler simply does nothing.
  const handlePrev = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    if (atStart) return;
    onSwitch(prevSessionId, { anchor, direction: 'prev', targetIndex: current - 1, total, ...describePress(event) });
  }, [atStart, onSwitch, prevSessionId, anchor, current, total]);

  const handleNext = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    if (atEnd) return;
    onSwitch(nextSessionId, { anchor, direction: 'next', targetIndex: current + 1, total, ...describePress(event) });
  }, [atEnd, onSwitch, nextSessionId, anchor, current, total]);

  // Switching branches replaces the prompt this pager lives in, so React
  // unmounts the button that was just pressed and focus falls to <body> — a
  // keyboard user would have to tab from the top of the page for every version
  // they step through (WCAG 2.4.3). Putting focus back is deliberately NOT done
  // here: this component cannot know whether the mount it is running in belongs
  // to the switch that was just made, and a mount that guesses wrong either
  // steals focus the user has moved elsewhere or misses its one chance when the
  // remount beats the response. The controller owns it and finds the arrow
  // through the two data attributes above. Landing on an `aria-disabled` arrow
  // at either end is intended: it stays focusable precisely so the journey ends
  // somewhere useful rather than at <body>.

  if (total < 2) return null;

  return (
    /* Grouping the chevrons into a pill keeps them legible as one control
       rather than decoration in the margin. The counter between them is
       shown: it was sr-only while a second, cluster-wide numbering existed
       in the sidebar and the two contradicted each other on screen. That
       list is gone, so this is now the only count — and without it the
       arrows cannot say how many versions exist or which one is on
       screen. */
    <div
      role="group"
      {...{ [PAGER_ANCHOR_ATTRIBUTE]: anchor }}
      aria-label={t('fork:branch.groupAria')}
      className="inline-flex items-center gap-0.5 rounded-full border border-border/60 bg-muted/40 px-1 py-0.5"
    >
      <Button
        type="button"
        variant="ghost"
        {...{ [PAGER_ARROW_ATTRIBUTE]: 'prev' }}
        onClick={handlePrev}
        aria-disabled={atStart}
        aria-label={t('fork:branch.previous')}
        className={`tap-target h-6 w-6 rounded-full p-0 [&_svg]:size-3.5 ${atStart ? 'cursor-default opacity-40 hover:bg-transparent' : ''}`}
      >
        <ChevronLeft aria-hidden />
      </Button>

      {/* `aria-hidden` so a virtual-cursor user reading through the row does
          not meet the position twice — once as this text and again from the
          transcript-level live region that speaks the switch. Mutating this
          span announces nothing on its own; it is static text outside any
          live region. `tabular-nums` stops the pill resizing as the digits
          change, which would nudge the whole row. */}
      <span aria-hidden className="px-0.5 text-[11px] tabular-nums leading-none">
        {current}/{total}
      </span>

      <Button
        type="button"
        variant="ghost"
        {...{ [PAGER_ARROW_ATTRIBUTE]: 'next' }}
        onClick={handleNext}
        aria-disabled={atEnd}
        aria-label={t('fork:branch.next')}
        className={`tap-target h-6 w-6 rounded-full p-0 [&_svg]:size-3.5 ${atEnd ? 'cursor-default opacity-40 hover:bg-transparent' : ''}`}
      >
        <ChevronRight aria-hidden />
      </Button>
    </div>
  );
}
