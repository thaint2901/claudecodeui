import { useCallback, useState } from 'react';
import { ChevronDown, GitBranch, Loader2 } from 'lucide-react';
import type { TFunction } from 'i18next';

import { api } from '../../../../utils/api';
import { cn } from '../../../../lib/utils';
import { formatCompactSessionAge } from '../../utils/utils';

/** One row of `GET /api/providers/sessions/:id/branches`. */
type SessionBranch = {
  sessionId: string;
  forkedFromSessionId: string | null;
  createdAt: string;
  activeLeaf: boolean;
  customName: string | null;
};

type SidebarSessionBranchesProps = {
  /** Any session in the cluster — the endpoint resolves the whole cluster from it. */
  sessionId: string;
  /** Cluster size already known from the session list; drives the collapsed label. */
  branchCount: number;
  /** Switches the app to `branchId` after it has been made the cluster's active leaf. */
  onSelectBranch: (branchId: string) => void;
  /** Shared clock from the sidebar so every row ages in step. */
  currentTime: Date;
  t: TFunction;
};

/**
 * Disclosure that lists every branch of a fork cluster.
 *
 * The sidebar deliberately collapses a cluster to a single row (only the
 * active leaf is listed), which left every sibling reachable *only* through
 * the small chevron control inside the transcript. This restores a way in:
 * the row keeps its single-line default, and the count expands into the full
 * list on demand.
 *
 * Branches load on expand rather than with the session list — a project with
 * many clusters would otherwise fire one request per cluster on every sidebar
 * render.
 */
export default function SidebarSessionBranches({
  sessionId,
  branchCount,
  onSelectBranch,
  currentTime,
  t,
}: SidebarSessionBranchesProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [branches, setBranches] = useState<SessionBranch[] | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [hasError, setHasError] = useState(false);

  const loadBranches = useCallback(async () => {
    setIsLoading(true);
    setHasError(false);
    try {
      const response = await api.sessionBranches(sessionId);
      if (!response.ok) {
        setHasError(true);
        return;
      }
      const json = await response.json();
      setBranches(json?.data?.branches ?? []);
    } catch (error) {
      console.error('[SidebarSessionBranches] Failed to load branches', error);
      setHasError(true);
    } finally {
      setIsLoading(false);
    }
  }, [sessionId]);

  const toggle = useCallback(() => {
    setIsExpanded((wasExpanded) => {
      // Refetch on every open: a branch can be created or renamed while the
      // list sits collapsed, and a stale list here sends the user to a leaf
      // that is no longer the one they mean.
      if (!wasExpanded) void loadBranches();
      return !wasExpanded;
    });
  }, [loadBranches]);

  const handleBranchClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      const branchId = event.currentTarget.dataset.branchId;
      if (branchId) onSelectBranch(branchId);
    },
    [onSelectBranch],
  );

  if (branchCount < 2) {
    return null;
  }

  return (
    <div className="mx-3 md:mx-0">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={isExpanded}
        className={cn(
          'tap-target flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs',
          'text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        )}
      >
        <GitBranch className="h-3.5 w-3.5 flex-shrink-0" aria-hidden />
        <span className="truncate">{t('sessions.branches.toggle', { count: branchCount })}</span>
        <ChevronDown
          className={cn('ml-auto h-3.5 w-3.5 flex-shrink-0 transition-transform', isExpanded && 'rotate-180')}
          aria-hidden
        />
      </button>

      {isExpanded && (
        <ul className="ml-2 space-y-0.5 border-l border-border/60 pl-2 pt-0.5">
          {isLoading && (
            <li className="flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
              {t('sessions.loading')}
            </li>
          )}

          {!isLoading && hasError && (
            <li className="px-2 py-1 text-xs text-destructive">{t('sessions.branches.loadFailed')}</li>
          )}

          {!isLoading &&
            !hasError &&
            (branches ?? []).map((branch, index) => {
              const label =
                branch.customName?.trim() ||
                t('sessions.branches.versionLabel', { index: index + 1 });
              return (
                <li key={branch.sessionId}>
                  <button
                    type="button"
                    data-branch-id={branch.sessionId}
                    onClick={handleBranchClick}
                    aria-current={branch.activeLeaf ? 'true' : undefined}
                    className={cn(
                      'tap-target flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs',
                      'transition-colors hover:bg-accent/50',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      branch.activeLeaf ? 'font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {/* Branches are frequently named after the same prompt —
                        two siblings here really are both "Say exactly: ONE".
                        The ordinal is what makes the list pickable. */}
                    <span
                      className={cn(
                        'w-3 flex-shrink-0 text-[10px] tabular-nums',
                        branch.activeLeaf ? 'text-primary' : 'text-muted-foreground',
                      )}
                      aria-hidden
                    >
                      {index + 1}
                    </span>
                    <span className="truncate">{label}</span>
                    {branch.activeLeaf ? (
                      <span className="ml-auto flex-shrink-0 text-[10px] uppercase tracking-wide text-primary">
                        {t('sessions.branches.current')}
                      </span>
                    ) : (
                      <span className="ml-auto flex-shrink-0 text-[11px] text-muted-foreground">
                        {formatCompactSessionAge(branch.createdAt, currentTime)}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
        </ul>
      )}
    </div>
  );
}
