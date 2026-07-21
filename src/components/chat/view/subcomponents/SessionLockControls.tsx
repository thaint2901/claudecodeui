import React from 'react';

import { useTranslation } from 'react-i18next';
import { Loader2, OctagonX, TriangleAlert } from 'lucide-react';

import { Alert, AlertDescription } from '../../../../shared/view/ui/Alert';
import { Button } from '../../../../shared/view/ui/Button';

/**
 * Inline banner shown above the prompt input when the current session is
 * locked by a background agent. Explains the situation and points the user
 * at the Stop & Resume action sitting in the composer footer.
 *
 * Built on the shared `Alert` primitive (same one `PermissionRequestsBanner`
 * uses) so it inherits theme-aware colors instead of hardcoded ones — the
 * previous `text-yellow-100` / `bg-yellow-500/10` pairing was unreadable in
 * light mode (~1:1 contrast) because it was only ever tuned against a dark
 * background.
 */
export function SessionLockBanner(): React.ReactElement {
  const { t } = useTranslation();
  return (
    <Alert
      data-testid="session-lock-banner"
      className="border-amber-500/40 bg-amber-500/10 dark:border-amber-500/30 dark:bg-amber-500/10"
    >
      <TriangleAlert aria-hidden="true" className="text-amber-600 dark:text-amber-400" />
      <AlertDescription className="text-amber-900 dark:text-amber-200">
        {t(
          'Session đang chạy dưới dạng background agent. Prompt sẽ được mở khóa khi session hoàn tất — hoặc dùng nút Stop & Resume bên dưới để dừng ngay.',
          'This session is running as a background agent. The prompt unlocks automatically when the session finishes — or use Stop & Resume to stop it now.',
        )}
      </AlertDescription>
    </Alert>
  );
}

interface SessionLockStopButtonProps {
  onClick: () => void;
  isStopping: boolean;
}

/**
 * Stop & Resume action. Replaces the normal send button while the session
 * is locked. Calls `claude stop` server-side, waits for the daemon to
 * release the lock, then re-enables the prompt composer.
 *
 * Uses the shared `Button` (variant="destructive") so it shares hover/focus/
 * disabled treatment with every other composer action instead of being a
 * one-off pill. The label collapses to icon-only below `sm` so it doesn't
 * wrap or crowd the token/message-count controls on narrow viewports.
 */
export function SessionLockStopButton({ onClick, isStopping }: SessionLockStopButtonProps): React.ReactElement {
  const { t } = useTranslation();
  const label = isStopping ? t('Đang dừng...', 'Stopping…') : t('Stop & Resume', 'Stop & Resume');

  return (
    <Button
      type="button"
      variant="destructive"
      size="sm"
      onClick={onClick}
      disabled={isStopping}
      data-testid="session-lock-stop-button"
      aria-label={label}
    >
      {isStopping ? <Loader2 aria-hidden="true" className="animate-spin" /> : <OctagonX aria-hidden="true" />}
      <span className="hidden sm:inline">{label}</span>
    </Button>
  );
}
