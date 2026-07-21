/**
 * Helpers for talking to the lock-status REST endpoint and triggering a
 * server-side `claude stop` on a background agent. The frontend uses these
 * to seed the lock state when a chat view opens and to drive the
 * Stop & Resume action.
 */

import { authenticatedFetch } from '../utils/api';

const DEFAULT_BASE_PATH = '/api/sessions';

function readBasePath(): string {
  if (typeof window === 'undefined') return DEFAULT_BASE_PATH;
  // Allow the host page to override the API base (used in dev when the
  // Vite proxy is mounted at a sub-path).
  const override = (window as { __CLOUDCLI_API_BASE__?: string }).__CLOUDCLI_API_BASE__;
  return override || DEFAULT_BASE_PATH;
}

interface LockStatusResponse {
  sessionId?: string;
  isLocked?: boolean;
  checkedAt?: string;
}

interface StopResponse {
  success?: boolean;
  message?: string;
}

export function sessionLockStatusApiUrl(sessionId: string | null | undefined): string {
  if (!sessionId) return '';
  return `${readBasePath()}/${encodeURIComponent(sessionId)}/lock-status`;
}

export function sessionStopApiUrl(sessionId: string | null | undefined): string {
  if (!sessionId) return '';
  return `${readBasePath()}/${encodeURIComponent(sessionId)}/stop`;
}

export async function fetchLockStatus(sessionId: string): Promise<boolean> {
  const url = sessionLockStatusApiUrl(sessionId);
  if (!url) return false;
  try {
    const response = await authenticatedFetch(url, { method: 'GET' });
    if (!response.ok) {
      return false;
    }
    const data: LockStatusResponse = await response.json();
    return Boolean(data.isLocked);
  } catch {
    return false;
  }
}

export async function postStopSession(sessionId: string): Promise<StopResponse> {
  const url = sessionStopApiUrl(sessionId);
  if (!url) {
    return { success: false, message: 'No session id' };
  }
  const response = await authenticatedFetch(url, { method: 'POST' });
  if (!response.ok) {
    return { success: false, message: `HTTP ${response.status}` };
  }
  try {
    return (await response.json()) as StopResponse;
  } catch {
    return { success: true };
  }
}
