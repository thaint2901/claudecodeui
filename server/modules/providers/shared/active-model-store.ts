import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readObjectRecord } from '@/shared/json.js';
import type {
  LLMProvider,
  ProviderChangeActiveModelInput,
  ProviderCurrentActiveModel,
  ProviderModelsDefinition,
  ProviderSessionActiveModelChange,
} from '@/shared/types.js';

// ---------------------------
//----------------- PROVIDER MODEL LOOKUP UTILITIES ------------
/**
 * Builds the standard "default current model" result used when a provider
 * cannot resolve a session-backed active model.
 *
 * Provider model adapters should call this after loading their supported model
 * catalog so the fallback stays aligned with the provider's current `DEFAULT`
 * selection instead of drifting to a hard-coded duplicate.
 */
export function buildDefaultProviderCurrentActiveModel(
  models: ProviderModelsDefinition,
): ProviderCurrentActiveModel {
  return {
    model: models.DEFAULT,
  };
}

// ---------------------------
//----------------- PROVIDER SESSION MODEL CHANGE UTILITIES ------------
type ProviderSessionActiveModelChangeCacheEntry = ProviderSessionActiveModelChange & {
  updatedAt: string;
};

type ProviderSessionActiveModelChangeCacheFile = {
  version: number;
  entries: Record<string, ProviderSessionActiveModelChangeCacheEntry>;
};

const PROVIDER_SESSION_ACTIVE_MODEL_CHANGE_CACHE_VERSION = 1;

/**
 * Resolves the backend-owned cache file used for session-scoped resume model
 * overrides.
 *
 * The file lives under `~/.cloudcli` because these overrides are an application
 * concern rather than a provider-native config file. Providers, routes, and
 * runtime command launchers should all use this helper instead of re-creating
 * the path so the storage location stays consistent.
 */
function getProviderSessionActiveModelChangesPath(): string {
  return path.join(os.homedir(), '.cloudcli', 'provider-session-active-model-changes.json');
}

const buildProviderSessionActiveModelChangeKey = (
  provider: LLMProvider,
  sessionId: string,
): string => `${provider}:${sessionId}`;

const isProviderSessionActiveModelChangeCacheEntry = (
  value: unknown,
): value is ProviderSessionActiveModelChangeCacheEntry => {
  const record = readObjectRecord(value);
  return Boolean(
    record
    && typeof record.provider === 'string'
    && typeof record.sessionId === 'string'
    && typeof record.supported === 'boolean'
    && typeof record.changed === 'boolean'
    && (typeof record.model === 'string' || record.model === null)
    && typeof record.updatedAt === 'string',
  );
};

const readProviderSessionActiveModelChangeCacheFile = async (
  filePath: string,
): Promise<ProviderSessionActiveModelChangeCacheFile> => {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = readObjectRecord(JSON.parse(raw));
    if (
      !parsed
      || parsed.version !== PROVIDER_SESSION_ACTIVE_MODEL_CHANGE_CACHE_VERSION
      || !readObjectRecord(parsed.entries)
    ) {
      return {
        version: PROVIDER_SESSION_ACTIVE_MODEL_CHANGE_CACHE_VERSION,
        entries: {},
      };
    }

    const entries = Object.fromEntries(
      Object.entries(parsed.entries).filter((entry): entry is [string, ProviderSessionActiveModelChangeCacheEntry] =>
        isProviderSessionActiveModelChangeCacheEntry(entry[1]),
      ),
    );

    return {
      version: PROVIDER_SESSION_ACTIVE_MODEL_CHANGE_CACHE_VERSION,
      entries,
    };
  } catch {
    return {
      version: PROVIDER_SESSION_ACTIVE_MODEL_CHANGE_CACHE_VERSION,
      entries: {},
    };
  }
};

const writeProviderSessionActiveModelChangeCacheFile = async (
  filePath: string,
  payload: ProviderSessionActiveModelChangeCacheFile,
): Promise<void> => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
};

const buildUnsupportedProviderSessionActiveModelChange = (
  provider: LLMProvider,
  sessionId: string,
): ProviderSessionActiveModelChange => ({
  provider,
  sessionId,
  supported: false,
  changed: false,
  model: null,
});

/**
 * Reads the persisted session model-change state for one provider session.
 *
 * Runtime resume paths use this to decide whether they should inject a
 * provider-specific model argument/thread option for the next resumed turn.
 * Missing cache entries are normalized to `{ changed: false }` so callers can
 * treat absence as "use the ordinary model selection flow".
 */
export async function readProviderSessionActiveModelChange(
  provider: LLMProvider,
  sessionId: string,
  options: {
    filePath?: string;
    supported?: boolean;
  } = {},
): Promise<ProviderSessionActiveModelChange> {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) {
    return buildUnsupportedProviderSessionActiveModelChange(provider, normalizedSessionId);
  }

  const supported = options.supported ?? true;
  if (!supported) {
    return buildUnsupportedProviderSessionActiveModelChange(provider, normalizedSessionId);
  }

  const filePath = options.filePath ?? getProviderSessionActiveModelChangesPath();
  const cacheFile = await readProviderSessionActiveModelChangeCacheFile(filePath);
  const cacheEntry = cacheFile.entries[
    buildProviderSessionActiveModelChangeKey(provider, normalizedSessionId)
  ];

  if (!cacheEntry || !cacheEntry.changed || !cacheEntry.model?.trim()) {
    return {
      provider,
      sessionId: normalizedSessionId,
      supported: true,
      changed: false,
      model: null,
    };
  }

  return {
    provider,
    sessionId: normalizedSessionId,
    supported: true,
    changed: true,
    model: cacheEntry.model.trim(),
  };
}

/**
 * Persists a session model-change request for one provider.
 *
 * Provider adapters call this when the frontend explicitly selects a different
 * model for an existing session. The stored `changed: true` flag is the single
 * source of truth used later by resume paths to decide whether they should add
 * a provider-native model override on the next invocation.
 */
export async function writeProviderSessionActiveModelChange(
  provider: LLMProvider,
  input: ProviderChangeActiveModelInput,
  options: {
    filePath?: string;
    supported?: boolean;
  } = {},
): Promise<ProviderSessionActiveModelChange> {
  const normalizedSessionId = input.sessionId.trim();
  const normalizedModel = input.model.trim();
  const supported = options.supported ?? true;

  if (!supported) {
    return buildUnsupportedProviderSessionActiveModelChange(provider, normalizedSessionId);
  }

  if (!normalizedSessionId || !normalizedModel) {
    return {
      provider,
      sessionId: normalizedSessionId,
      supported: true,
      changed: false,
      model: null,
    };
  }

  const filePath = options.filePath ?? getProviderSessionActiveModelChangesPath();
  const cacheFile = await readProviderSessionActiveModelChangeCacheFile(filePath);
  cacheFile.entries[buildProviderSessionActiveModelChangeKey(provider, normalizedSessionId)] = {
    provider,
    sessionId: normalizedSessionId,
    supported: true,
    changed: true,
    model: normalizedModel,
    updatedAt: new Date().toISOString(),
  };

  await writeProviderSessionActiveModelChangeCacheFile(filePath, cacheFile);

  return {
    provider,
    sessionId: normalizedSessionId,
    supported: true,
    changed: true,
    model: normalizedModel,
  };
}
