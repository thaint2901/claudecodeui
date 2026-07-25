import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';

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
  if (total < 2) return null;
  return (
    <div className="mt-1 flex items-center justify-end gap-1 text-xs text-muted-foreground">
      <button
        type="button"
        onClick={() => onSwitch(prevSessionId)}
        disabled={current <= 1}
        aria-label={t('branch.previous')}
        className="disabled:opacity-40"
      >
        <ChevronLeft className="h-3 w-3" />
      </button>
      <span>{current}/{total}</span>
      <button
        type="button"
        onClick={() => onSwitch(nextSessionId)}
        disabled={current >= total}
        aria-label={t('branch.next')}
        className="disabled:opacity-40"
      >
        <ChevronRight className="h-3 w-3" />
      </button>
    </div>
  );
}
