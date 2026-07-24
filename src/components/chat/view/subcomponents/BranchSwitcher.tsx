import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';

type BranchSwitcherProps = {
  /** 1-based index of the branch currently displayed at this fork point. */
  current: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
};

export function BranchSwitcher({ current, total, onPrev, onNext }: BranchSwitcherProps) {
  const { t } = useTranslation('chat');
  if (total < 2) return null;
  return (
    <div className="mt-1 flex items-center justify-end gap-1 text-xs text-muted-foreground">
      <button
        type="button"
        onClick={onPrev}
        disabled={current <= 1}
        aria-label={t('branch.previous')}
        className="disabled:opacity-40"
      >
        <ChevronLeft className="h-3 w-3" />
      </button>
      <span>{current}/{total}</span>
      <button
        type="button"
        onClick={onNext}
        disabled={current >= total}
        aria-label={t('branch.next')}
        className="disabled:opacity-40"
      >
        <ChevronRight className="h-3 w-3" />
      </button>
    </div>
  );
}
