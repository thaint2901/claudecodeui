import type { IProviderAuth } from '@/shared/interfaces.js';

/**
 * Returns whether a provider runtime appears installed, given the provider's
 * own auth instance directly (no registry lookup).
 *
 * Falls back to `true` if the status lookup itself fails so callers preserve
 * the original runtime error instead of replacing it with a status-check
 * failure. Mirrors `provider-auth.service.ts`'s `isProviderInstalled` exactly.
 */
export async function isProviderInstalled(auth: IProviderAuth): Promise<boolean> {
  try {
    const status = await auth.getStatus();
    return status.installed;
  } catch {
    return true;
  }
}
