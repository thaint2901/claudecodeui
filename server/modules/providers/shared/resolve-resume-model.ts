import type { LLMProvider } from '@/shared/types.js';

import { readProviderSessionActiveModelChange } from './active-model-store.js';

/**
 * Resolves the model a resumed session should use: a session-scoped active-model
 * change (set via the model switcher mid-session) takes precedence over the
 * caller-requested model.
 *
 * Mirrors `provider-models.service.ts`'s (now-removed) `resolveResumeModel`
 * exactly. It intentionally does not depend on the provider registry — the
 * active-model-change lookup is file-based, not provider-instance based — so
 * CLI runtime files under `list/` can call it directly without importing
 * `providers/services/**`.
 */
export async function resolveResumeModel(
  provider: LLMProvider,
  sessionId: string | undefined,
  requestedModel?: string | null,
): Promise<string | undefined> {
  const normalizedRequestedModel = typeof requestedModel === 'string' ? requestedModel.trim() : '';
  if (!sessionId?.trim()) {
    return normalizedRequestedModel || undefined;
  }

  const changedModel = await readProviderSessionActiveModelChange(provider, sessionId);
  if (changedModel.supported && changedModel.changed && changedModel.model?.trim()) {
    return changedModel.model.trim();
  }

  return normalizedRequestedModel || undefined;
}
