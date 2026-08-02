import type {
  FetchHistoryOptions,
  FetchHistoryResult,
  LLMProvider,
  McpScope,
  NormalizedMessage,
  ProviderSkill,
  ProviderSkillListOptions,
  ProviderAuthStatus,
  ProviderChangeActiveModelInput,
  ProviderCurrentActiveModel,
  ProviderModelsDefinition,
  ProviderMcpServer,
  ProviderSessionActiveModelChange,
  ProviderSessionId,
  ProviderSkillCreateInput,
  ProviderSkillRemoveInput,
  UpsertProviderMcpServerInput,
} from '@/shared/types.js';

//----------------- PROVIDER CONTRACT INTERFACES ------------
/**
 * Main provider contract for CLI and SDK integrations.
 *
 * Each concrete provider owns its MCP/auth handlers plus the provider-specific
 * logic for converting native events/history into the app's normalized shape.
 */
export interface IProvider {
  readonly id: LLMProvider;
  readonly models: IProviderModels;
  readonly mcp: IProviderMcp;
  readonly auth: IProviderAuth;
  readonly skills: IProviderSkills;
  readonly sessions: IProviderSessions;
  readonly sessionSynchronizer: IProviderSessionSynchronizer;
}

// ---------------------------
//----------------- PROVIDER MODEL INTERFACE ------------
/**
 * Model catalog contract for one provider.
 *
 * Implementations are responsible for resolving the provider's currently
 * supported models and converting them into the shared
 * `ProviderModelsDefinition` shape used by backend routes and frontend model
 * pickers. The `DEFAULT` field should be the most appropriate default selection
 * for that provider at the time the catalog is read.
 */
export interface IProviderModels {
  /**
   * Returns the provider's currently supported model catalog.
   */
  getSupportedModels(): Promise<ProviderModelsDefinition>;

  /**
   * Returns the currently active model for one session or provider runtime.
   *
   * Implementations must use the provider-specific lookup mechanism approved
   * for that provider and fall back only to the provider catalog default when
   * no active model can be resolved.
   */
  getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel>;

  /**
   * Persists a session-scoped model override that the next resumed turn should
   * honor for this provider.
   *
   * This does not require the provider to mutate an already running remote
   * session in-place. Instead, adapters store the user's explicit model choice
   * so the backend resume path can add the correct provider-native model option
   * on the next CLI/SDK invocation for the same session.
   */
  changeActiveModel(
    input: ProviderChangeActiveModelInput,
  ): Promise<ProviderSessionActiveModelChange>;
}

// ---------------------------
//----------------- PROVIDER AUTH INTERFACE ------------
/**
 * Auth contract for one provider.
 *
 * Implementations should return a complete installation/authentication status
 * without throwing for normal "not installed" or "not authenticated" states.
 */
export interface IProviderAuth {
  /**
   * Checks whether the provider is installed and has usable credentials.
   */
  getStatus(): Promise<ProviderAuthStatus>;
}

// ---------------------------
//----------------- PROVIDER SKILLS INTERFACE ------------
/**
 * Skills contract for one provider.
 *
 * Implementations discover provider-native skill markdown locations and return
 * normalized skill records with the exact command syntax expected by that
 * provider. Each skill is read from a `SKILL.md` file under its skill directory.
 */
export interface IProviderSkills {
  /**
   * Lists all skills visible to this provider for the optional workspace.
   */
  listSkills(options?: ProviderSkillListOptions): Promise<ProviderSkill[]>;

  /**
   * Writes one or more global user-scoped skills for this provider.
   *
   * Implementations should install the supplied markdown entries into the
   * provider's writable user skill folder and return the normalized skill
   * records that were written.
   */
  addSkills(input: ProviderSkillCreateInput): Promise<ProviderSkill[]>;

  removeSkill(
    input: ProviderSkillRemoveInput,
  ): Promise<{ removed: boolean; provider: LLMProvider; directoryName: string }>;
}

// ---------------------------
//----------------- PROVIDER MCP INTERFACE ------------
/**
 * MCP contract for one provider.
 *
 * Implementations must map provider-native MCP config formats to shared
 * `ProviderMcpServer` records used by routes and frontend state.
 */
export interface IProviderMcp {
  listServers(options?: { workspacePath?: string }): Promise<Record<McpScope, ProviderMcpServer[]>>;
  listServersForScope(scope: McpScope, options?: { workspacePath?: string }): Promise<ProviderMcpServer[]>;
  upsertServer(input: UpsertProviderMcpServerInput): Promise<ProviderMcpServer>;
  removeServer(
    input: { name: string; scope?: McpScope; workspacePath?: string },
  ): Promise<{ removed: boolean; provider: LLMProvider; name: string; scope: McpScope }>;
}

// ---------------------------
//----------------- PROVIDER SESSION INTERFACE ------------
/**
 * Session/history contract for one provider.
 *
 * Implementations normalize provider-specific events and message history into
 * shared transport shapes consumed by API routes and realtime streams.
 */
export interface IProviderSessions {
  normalizeMessage(raw: unknown, sessionId: string | null): NormalizedMessage[];
  fetchHistory(sessionId: string, options?: FetchHistoryOptions): Promise<FetchHistoryResult>;
}

// ---------------------------
//----------------- PROVIDER SESSION SYNCHRONIZER INTERFACE ------------
/**
 * Session indexing contract for one provider.
 *
 * Implementations scan provider-specific session artifacts on disk and upsert
 * normalized session metadata into the database. The service layer uses this
 * interface for both full rescans and single-file incremental sync triggered
 * by filesystem watcher events.
 */
export interface IProviderSessionSynchronizer {
  /**
   * Scans provider session artifacts and upserts discovered sessions into DB.
   */
  synchronize(since?: Date): Promise<number>;

  /**
   * Parses and upserts one provider artifact file without running a full scan.
   */
  synchronizeFile(filePath: string): Promise<string | null>;

  /**
   * Best-effort write-back of a user-set display name into the provider's own
   * on-disk session artifact, so native CLI tooling that later reads the
   * transcript (terminal title, explicit-id `claude --resume <id>`) reflects
   * the same name the app shows. This does NOT make a session appear in (or
   * relabel it within) the interactive `claude --resume` picker for sessions
   * originated by this app — Claude Code excludes Agent-SDK-origin sessions
   * from that picker regardless of title. Providers with no on-disk artifact
   * format simply don't implement this.
   *
   * `projectPath`, when known, scopes the on-disk lookup to that project
   * directory instead of searching every project under the provider's config
   * dir — pass it whenever the caller already has it.
   *
   * Returns `true` when the write-back actually landed, `false` when it was
   * swallowed (missing transcript, unsupported provider, etc.) — callers
   * that need to know whether the name will survive the next sync (e.g. the
   * `/fork` flow) can act on this instead of only seeing the resolved promise.
   */
  writeBackCustomName?(providerSessionId: ProviderSessionId, customName: string, projectPath?: string): Promise<boolean>;
}

// ---------------------------
//----------------- PROVIDER RUNTIME INTERFACE ------------
/**
 * Writer handed to a run. ChatSessionWriter, SSEStreamWriter and the
 * inline writers in routes/git.js all satisfy it today.
 */
export interface ProviderRunWriter {
  send(message: unknown): void;
  /**
   * Optional: how app-level tracking learns the provider-native session id.
   * Claude MAY call this more than once (fork recapture).
   */
  setSessionId?(providerSessionId: string): void;
  userId?: number | string | null;
  isWebSocketWriter?: boolean;
  isSSEStreamWriter?: boolean;
}

/**
 * Options bag for one run. Known keys typed; providers tolerate extras
 * (the hub spreads client options), hence the index signature.
 */
export interface ProviderRunOptions {
  sessionId?: string | null;
  sessionSummary?: string | null;
  cwd?: string;
  projectPath?: string;
  model?: string;
  effort?: string;
  images?: unknown[];
  permissionMode?: string;
  toolsSettings?: Record<string, unknown>;
  skipPermissions?: boolean;
  resume?: boolean;
  forkSession?: boolean;
  forkSubagent?: boolean;
  resumeSessionAt?: string;
  [key: string]: unknown;
}

export interface IProviderRuntimeApprovals {
  /** Resolve a pending canUseTool request. Returns false for unknown ids. */
  resolve(requestId: string, decision: Record<string, unknown>): boolean;
  getPendingForSession(providerSessionId: string): unknown[];
}

/**
 * Execution contract for one provider.
 *
 * run(): resolves when the run ends. MAY reject on spawn/exit failure
 * (Cursor, OpenCode today) but MUST have already emitted `error` +
 * `complete` events via the writer before rejecting — callers treat
 * rejection as already-reported. Claude/Codex never reject.
 *
 * abort(): keyed by the provider-native session id; returns whether a
 * live run was found and signalled. Sync or async per provider.
 */
export interface IProviderRuntime {
  run(command: string, options: ProviderRunOptions, writer: ProviderRunWriter): Promise<void>;
  abort(providerSessionId: string): boolean | Promise<boolean>;
  /** Claude-only tool-approval channel; absent for providers without one. */
  readonly approvals?: IProviderRuntimeApprovals;
}
