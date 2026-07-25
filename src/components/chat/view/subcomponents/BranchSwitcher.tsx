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
    <div className="mt-1 flex items-center justify-end">
      {/* A bare row of grey chevrons floating in the margin read as decoration.
          Grouping them into a labelled pill makes it legible as one control
          that changes which version of the conversation is on screen. */}
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

        {/* Visible wording, not just "3/3": the number alone tells a reader
            nothing about what is being counted. `text-foreground` also clears
            the 4.5:1 body-text ratio that muted-foreground missed in light
            mode (measured 4.43:1). */}
        <span className="select-none whitespace-nowrap px-1 text-[11px] font-medium text-foreground">
          {t('branch.counter', { current, total })}
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
          anything happened at all. */}
      <span role="status" aria-live="polite" className="sr-only">
        {t('branch.announced', { current, total })}
      </span>
    </div>
  );
}
