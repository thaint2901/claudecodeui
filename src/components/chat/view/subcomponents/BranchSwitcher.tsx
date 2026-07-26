import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../../../shared/view/ui';

type BranchSwitcherProps = {
  /** 1-based index of the branch currently displayed at this fork point. */
  current: number;
  total: number;
  /** Sibling ids to move to, or undefined at either end of the list. */
  prevSessionId?: string;
  nextSessionId?: string;
  /**
   * Takes the target id rather than two ready-made callbacks: the caller
   * renders this once per fork anchor, and per-anchor arrow props would hand
   * every message row a fresh identity on each render.
   */
  onSwitch: (sessionId?: string) => void;
};

export function BranchSwitcher({ current, total, prevSessionId, nextSessionId, onSwitch }: BranchSwitcherProps) {
  const { t } = useTranslation('chat');

  const atStart = current <= 1;
  const atEnd = current >= total;

  // `disabled` would drop focus to <body> the moment the last press lands on
  // the end of the list, forcing a keyboard user to tab back from the top of
  // the page (WCAG 2.4.3). `aria-disabled` keeps the control focusable and
  // announced as unavailable, and the handler simply does nothing.
  const handlePrev = useCallback(() => {
    if (atStart) return;
    onSwitch(prevSessionId);
  }, [atStart, onSwitch, prevSessionId]);

  const handleNext = useCallback(() => {
    if (atEnd) return;
    onSwitch(nextSessionId);
  }, [atEnd, onSwitch, nextSessionId]);

  if (total < 2) return null;

  return (
    <span className="inline-flex items-center">
      {/* Grouping the chevrons into a pill keeps them legible as one control
          rather than decoration in the margin. The counter between them is
          shown: it was sr-only while a second, cluster-wide numbering existed
          in the sidebar and the two contradicted each other on screen. That
          list is gone, so this is now the only count — and without it the
          arrows cannot say how many versions exist or which one is on
          screen. */}
      <div
        role="group"
        aria-label={t('branch.groupAria')}
        className="inline-flex items-center gap-0.5 rounded-full border border-border/60 bg-muted/40 px-1 py-0.5"
      >
        <Button
          type="button"
          variant="ghost"
          onClick={handlePrev}
          aria-disabled={atStart}
          aria-label={t('branch.previous')}
          className={`tap-target h-6 w-6 rounded-full p-0 [&_svg]:size-3.5 ${atStart ? 'cursor-default opacity-40 hover:bg-transparent' : ''}`}
        >
          <ChevronLeft aria-hidden />
        </Button>

        {/* `aria-hidden` because the live region below already speaks the
            position — without it a screen reader announces the count twice on
            every switch. `tabular-nums` stops the pill resizing as the digits
            change, which would nudge the whole row. */}
        <span aria-hidden className="px-0.5 text-[11px] tabular-nums leading-none">
          {current}/{total}
        </span>

        <Button
          type="button"
          variant="ghost"
          onClick={handleNext}
          aria-disabled={atEnd}
          aria-label={t('branch.next')}
          className={`tap-target h-6 w-6 rounded-full p-0 [&_svg]:size-3.5 ${atEnd ? 'cursor-default opacity-40 hover:bg-transparent' : ''}`}
        >
          <ChevronRight aria-hidden />
        </Button>
      </div>

      {/* Switching branches swaps the entire transcript underneath the reader.
          Without a live region a screen reader user gets no signal that
          anything happened at all — and unlike sighted users, who can see the
          messages change, they have nothing else to go on. A visible counter
          does not replace this: static text changing off-focus is not
          announced. */}
      <span role="status" aria-live="polite" className="sr-only">
        {t('branch.announced', { current, total })}
      </span>
    </span>
  );
}
