import fs from 'node:fs';
import {
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import { parseFrontMatter } from '@/shared/frontmatter.js';
import type {
  LLMProvider,
  ProviderChangeActiveModelInput,
  ProviderCurrentActiveModel,
  ProviderModelsDefinition,
  ProviderSessionActiveModelChange,
  ProviderSkillSource,
} from '@/shared/types.js';

export { AppError, asyncHandler, createApiSuccessResponse } from './http.js';
export { WORKSPACES_ROOT, normalizeProjectPath, validateWorkspacePath } from './workspace-paths.js';
export { createCompleteMessage, createNormalizedMessage, generateMessageId, sliceTailPage } from './messages.js';
export {
  parseIncomingJsonObject,
  readJsonConfig,
  readJsonRecord,
  readObjectRecord,
  readOptionalString,
  readStringArray,
  readStringRecord,
  writeJsonConfig,
} from './json.js';

import { readObjectRecord, readOptionalString } from './json.js';

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
export function getProviderSessionActiveModelChangesPath(): string {
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

// ---------------------------
//----------------- PROVIDER SKILL FILE UTILITIES ------------
async function hasGitMarker(dirPath: string): Promise<boolean> {
  try {
    const gitMarkerStats = await stat(path.join(dirPath, '.git'));
    return gitMarkerStats.isDirectory() || gitMarkerStats.isFile();
  } catch {
    return false;
  }
}

/**
 * Finds the highest git worktree root visible from a starting directory.
 *
 * Provider skill systems such as Codex and OpenCode walk upward through parent
 * folders when resolving repository/project skills. Use this helper when a
 * provider needs the topmost `.git` marker instead of only the nearest one, so
 * monorepos and nested package folders discover shared root-level skills once.
 */
export async function findTopmostGitRoot(startPath: string): Promise<string | null> {
  let currentPath = path.resolve(startPath);
  let topmostGitRoot: string | null = null;

  while (true) {
    if (await hasGitMarker(currentPath)) {
      topmostGitRoot = currentPath;
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      break;
    }

    currentPath = parentPath;
  }

  return topmostGitRoot;
}

/**
 * Adds one provider skill source after normalizing and de-duplicating its root.
 *
 * Provider skill lookup rules often point at overlapping folders (for example a
 * workspace folder can also be the git root). Use this helper while building a
 * provider's `ProviderSkillSource[]` so the shared skills scanner reads each
 * physical root once and still preserves provider-specific scope/command data.
 */
export function addUniqueProviderSkillSource(
  sources: ProviderSkillSource[],
  seenRootDirs: Set<string>,
  source: ProviderSkillSource,
): void {
  const normalizedRootDir = path.resolve(source.rootDir);
  if (seenRootDirs.has(normalizedRootDir)) {
    return;
  }

  seenRootDirs.add(normalizedRootDir);
  sources.push({ ...source, rootDir: normalizedRootDir });
}

// ---------------------------
//----------------- PROVIDER SKILL MARKDOWN UTILITIES ------------
/**
 * Finds direct child skill markdown files under a provider skill root.
 *
 * Skill systems usually store one skill per child directory, so direct mode
 * scans only `<root>/<skill-name>/SKILL.md`. Recursive mode is reserved for
 * provider sources that can nest skills arbitrarily, and it returns every
 * descendant `SKILL.md`. Missing or unreadable roots return an empty list
 * because users may not have every provider installed or configured.
 */
export async function findProviderSkillMarkdownFiles(
  rootDir: string,
  options: { recursive?: boolean } = {},
): Promise<string[]> {
  const skillFiles: string[] = [];

  const collectRecursive = async (dirPath: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    try {
      const skillPath = path.join(dirPath, 'SKILL.md');
      const skillStats = await stat(skillPath);
      if (skillStats.isFile()) {
        skillFiles.push(skillPath);
      }
    } catch {
      // Directories without SKILL.md are expected while walking plugin trees.
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        await collectRecursive(path.join(dirPath, entry.name));
      }
    }
  };

  if (options.recursive) {
    await collectRecursive(rootDir);
    return skillFiles.sort((left, right) => left.localeCompare(right));
  }

  try {
    const entries = await readdir(rootDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const skillPath = path.join(rootDir, entry.name, 'SKILL.md');
      try {
        const skillStats = await stat(skillPath);
        if (skillStats.isFile()) {
          skillFiles.push(skillPath);
        }
      } catch {
        // A partial skill directory should not block discovery of sibling skills.
      }
    }

    return skillFiles.sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

/**
 * Reads the `name` and `description` fields from a provider skill markdown file.
 *
 * The metadata is expected in markdown front matter. If a skill omits `name`, the
 * parent directory name is used as a stable fallback so providers can still
 * expose the skill. Missing descriptions are normalized to an empty string.
 */
export async function readProviderSkillMarkdownDefinition(
  skillPath: string,
): Promise<{ name: string; description: string }> {
  const content = await readFile(skillPath, 'utf8');
  return readProviderSkillMarkdownDefinitionFromContent(
    content,
    path.basename(path.dirname(skillPath)),
  );
}

/**
 * Reads the `name` and `description` fields from raw skill markdown content.
 *
 * This keeps filesystem discovery and newly uploaded skill creation aligned on
 * the same front matter parsing rules. `fallbackName` is used when the markdown
 * omits a `name` field so callers still get a stable, non-empty skill id.
 */
export function readProviderSkillMarkdownDefinitionFromContent(
  content: string,
  fallbackName: string,
): { name: string; description: string } {
  const parsed = parseFrontMatter(content);
  const data = readObjectRecord(parsed.data) ?? {};

  return {
    name: readOptionalString(data.name) ?? fallbackName,
    description: readOptionalString(data.description) ?? '',
  };
}

// ---------------------------
//----------------- SESSION SYNCHRONIZER TITLE HELPERS ------------
/**
 * Produces a compact session title suitable for UI rendering and DB storage.
 *
 * Use this when converting provider-native names into a consistent title value.
 * The helper collapses repeated whitespace, trims the result, and truncates it
 * to 120 characters so every provider writes stable and bounded metadata.
 * If the normalized input is empty, it returns the supplied fallback title.
 */
export function normalizeSessionName(rawValue: string | undefined, fallback: string): string {
  const normalized = (rawValue ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return fallback;
  }

  return normalized.slice(0, 120);
}

// ---------------------------
//----------------- PROVIDER SESSION VALUE NORMALIZATION UTILITIES ------------
/**
 * Converts provider-native timestamps into ISO strings.
 *
 * Provider CLIs commonly persist epoch timestamps as milliseconds, seconds, or
 * already-formatted date strings. Use this helper when normalizing session
 * metadata or transcript events so every provider writes the same ISO timestamp
 * shape to API responses and database rows.
 */
export function normalizeProviderTimestamp(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const millis = value < 1_000_000_000_000 ? value * 1000 : value;
    return new Date(millis).toISOString();
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return normalizeProviderTimestamp(parsed);
    }

    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return date.toISOString();
    }
  }

  return new Date().toISOString();
}

// ---------------------------
//----------------- OPENCODE SESSION STORAGE UTILITIES ------------
/**
 * Resolves the OpenCode SQLite session database path.
 *
 * OpenCode stores session, message, part, and project metadata in one shared
 * `opencode.db` file under its XDG data directory. Provider readers and
 * synchronizers should use this path for read-only access and should never store
 * it as a deletable transcript path for an individual app session row.
 */
export function getOpenCodeDatabasePath(): string {
  return path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
}

/**
 * Decodes an OpenCode text payload that was persisted as a JSON string literal.
 *
 * OpenCode can store the first user prompt (and other text parts) as `"hello"`
 * instead of `hello`. Used by both the OpenCode session reader (transcript
 * history) and the OpenCode synchronizer (session titling) so a session name or
 * message body never surfaces with surrounding quote characters. Only fully
 * quoted, valid JSON string literals are unwrapped; ordinary prose that merely
 * happens to start/end with a quote is returned untouched.
 */
export function unwrapJsonStringLiteral(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) {
    return value;
  }

  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed === 'string' ? parsed : value;
  } catch {
    return value;
  }
}

// ---------------------------
//----------------- SAFE DIRECTORY NAME UTILITIES ------------
/**
 * Validates that a user or provider supplied identifier can safely be treated
 * as one leaf directory name under an existing root folder.
 *
 * Use this before composing paths like `<root>/<session-id>/file.db>` to block
 * path traversal and accidental nested paths. The returned string is trimmed but
 * otherwise unchanged so callers can still match the provider's on-disk naming.
 */
export function sanitizeLeafDirectoryName(inputName: string, label = 'directory name'): string {
  const normalized = inputName.trim();
  if (!normalized) {
    throw new Error(`${label} is required.`);
  }

  if (
    normalized.includes('..')
    || normalized.includes(path.posix.sep)
    || normalized.includes(path.win32.sep)
    || normalized !== path.basename(normalized)
  ) {
    throw new Error(`Invalid ${label} "${inputName}".`);
  }

  return normalized;
}

// ---------------------------
//----------------- SESSION SYNCHRONIZER FILESYSTEM HELPERS ------------
/**
 * Recursively discovers files that match one extension, with optional incremental filtering.
 *
 * Provider synchronizers call this to find transcript artifacts under provider
 * home directories. Pass `lastScanAt` to include only files created after the
 * previous scan, or pass `null` to perform a full rescan. Missing directories
 * are treated as empty because not every provider exists on every machine.
 */
export async function findFilesRecursivelyCreatedAfter(
  rootDir: string,
  extension: string,
  lastScanAt: Date | null,
  fileList: string[] = []
): Promise<string[]> {
  try {
    const entries = await readdir(rootDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(rootDir, entry.name);

      if (entry.isDirectory()) {
        await findFilesRecursivelyCreatedAfter(fullPath, extension, lastScanAt, fileList);
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith(extension)) {
        continue;
      }

      if (!lastScanAt) {
        fileList.push(fullPath);
        continue;
      }

      const fileStat = await stat(fullPath);
      if (fileStat.birthtime > lastScanAt) {
        fileList.push(fullPath);
      }
    }
  } catch {
    // Missing provider folders are expected in first-run or partial setups.
  }

  return fileList;
}

/**
 * Reads file creation/update timestamps and maps them to DB-friendly ISO strings.
 *
 * Session indexers use this to persist `created_at` and `updated_at` metadata
 * when upserting sessions. If the file cannot be read, an empty object is
 * returned so indexing can continue for other files.
 */
export async function readFileTimestamps(
  filePath: string
): Promise<{ createdAt?: string; updatedAt?: string }> {
  try {
    const fileStat = await stat(filePath);
    return {
      createdAt: fileStat.birthtime.toISOString(),
      updatedAt: fileStat.mtime.toISOString(),
    };
  } catch {
    return {};
  }
}

// ---------------------------
//----------------- SESSION SYNCHRONIZER JSONL PARSING HELPERS ------------
/**
 * Builds a first-seen key/value lookup map from a JSONL file.
 *
 * Use this for provider index files where session id -> display name metadata
 * is stored line-by-line. The first value for each key wins, preserving the
 * earliest known label while avoiding repeated map overwrites.
 */
export async function buildLookupMap(
  filePath: string,
  keyField: string,
  valueField: string
): Promise<Map<string, string>> {
  const lookup = new Map<string, string>();

  try {
    const fileStream = fs.createReadStream(filePath);
    const lineReader = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    for await (const line of lineReader) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const key = parsed[keyField];
      const value = parsed[valueField];

      if (typeof key === 'string' && typeof value === 'string' && !lookup.has(key)) {
        lookup.set(key, value);
      }
    }
  } catch {
    // Missing or unreadable lookup files should not block session sync.
  }

  return lookup;
}

/**
 * Reads a JSONL file and returns the first extracted payload that matches caller criteria.
 *
 * The caller supplies an `extractor` that validates provider-specific row
 * shapes. This helper centralizes line-by-line parsing and lets indexers stop
 * scanning as soon as one valid row is found.
 */
export async function extractFirstValidJsonlData<T>(
  filePath: string,
  extractor: (parsedJson: unknown) => T | null | undefined
): Promise<T | null> {
  try {
    const fileStream = fs.createReadStream(filePath);
    const lineReader = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    for await (const line of lineReader) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      const parsed = JSON.parse(trimmed);
      const extracted = extractor(parsed);
      if (extracted) {
        lineReader.close();
        fileStream.close();
        return extracted;
      }
    }
  } catch {
    // Ignore malformed or missing artifacts so full scans keep progressing.
  }

  return null;
}

// ---------------------------
//----------------- CLI PROMPT ARGUMENT UTILITIES ------------
/**
 * Makes a prompt safe to pass as one CLI argument to `.cmd`-shimmed tools on
 * Windows (cursor-agent and opencode installed via npm-style shims).
 *
 * cmd.exe cannot carry newlines inside an argument: everything after the
 * first newline is silently dropped before the target CLI ever sees it, which
 * truncates multi-line prompts and any appended `<images_input>` block.
 * Collapsing newline runs to single spaces loses formatting but never loses
 * content, so runtimes should call this on win32 right before spawning.
 *
 * Used by the cursor and opencode spawn runtimes.
 */
export function flattenPromptForWindowsShell(prompt: string): string {
  if (process.platform !== 'win32' || typeof prompt !== 'string') {
    return prompt;
  }
  return prompt.replace(/\s*\r?\n\s*/g, ' ').trim();
}
