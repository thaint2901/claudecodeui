import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

import { renameSession } from '@anthropic-ai/claude-agent-sdk';

import { sessionsDb } from '@/modules/database/index.js';
import {
  buildLookupMap,
  extractFirstValidJsonlData,
  findFilesRecursivelyCreatedAfter,
  normalizeSessionName,
  readFileTimestamps,
} from '@/shared/utils.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';

type ParsedSession = {
  sessionId: string;
  projectPath: string;
  sessionName?: string;
};

/**
 * Session indexer for Claude transcript artifacts.
 */
export class ClaudeSessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'claude' as const;
  private readonly claudeHome = path.join(os.homedir(), '.claude');

  /**
   * Returns true when a JSONL file is a subagent transcript rather than a
   * top-level session.
   *
   * Claude stores subagent transcripts under a `subagents/` directory, e.g.
   * `~/.claude/projects/<encoded-cwd>/<session-id>/subagents/agent-<id>.jsonl`.
   * Those files repeat the parent session's `sessionId`, so indexing them as
   * standalone sessions overwrites the parent row's `jsonl_path` and corrupts
   * the main session record. The recursive scan in `synchronize()` reaches
   * them, so both entry points must skip them.
   */
  private isSubagentTranscript(filePath: string): boolean {
    return path.normalize(filePath).split(path.sep).includes('subagents');
  }

  /**
   * Scans ~/.claude/projects and upserts discovered sessions into DB.
   */
  async synchronize(since?: Date): Promise<number> {
    const nameMap = await buildLookupMap(path.join(this.claudeHome, 'history.jsonl'), 'sessionId', 'display');
    const files = await findFilesRecursivelyCreatedAfter(
      path.join(this.claudeHome, 'projects'),
      '.jsonl',
      since ?? null
    );

    let processed = 0;
    for (const filePath of files) {
      if (this.isSubagentTranscript(filePath)) {
        continue;
      }

      const parsed = await this.processSessionFile(filePath, nameMap);
      if (!parsed) {
        continue;
      }

      const timestamps = await readFileTimestamps(filePath);
      sessionsDb.createSession(
        parsed.sessionId,
        this.provider,
        parsed.projectPath,
        parsed.sessionName,
        timestamps.createdAt,
        timestamps.updatedAt,
        filePath
      );
      processed += 1;
    }

    return processed;
  }

  /**
   * Parses and upserts one Claude session JSONL file.
   */
  async synchronizeFile(filePath: string): Promise<string | null> {
    if (!filePath.endsWith('.jsonl')) {
      return null;
    }
    if (this.isSubagentTranscript(filePath)) {
      return null;
    }

    const nameMap = await buildLookupMap(path.join(this.claudeHome, 'history.jsonl'), 'sessionId', 'display');
    const parsed = await this.processSessionFile(filePath, nameMap);
    if (!parsed) {
      return null;
    }

    const timestamps = await readFileTimestamps(filePath);
    return sessionsDb.createSession(
      parsed.sessionId,
      this.provider,
      parsed.projectPath,
      parsed.sessionName,
      timestamps.createdAt,
      timestamps.updatedAt,
      filePath
    );
  }

  /**
   * Renames the session's own transcript via the Agent SDK's `renameSession`,
   * so a webui rename becomes visible to native CLI tooling (`claude
   * --resume`, terminal title) the same way `claude -n <name>`/`/rename`
   * would. `renameSession` locates the transcript by searching
   * `~/.claude/projects/**` for the session id, so no jsonl path bookkeeping
   * is needed here.
   *
   * Best-effort: if the session has no transcript on disk yet (e.g. an
   * app-created session that hasn't produced a Claude Code process run yet),
   * `renameSession` rejects and this silently swallows that instead of
   * failing the rename API call — the DB name is the source of truth for
   * the webui regardless of whether the disk write-back succeeded.
   */
  async writeBackCustomName(providerSessionId: string, customName: string): Promise<void> {
    try {
      await renameSession(providerSessionId, customName);
    } catch (error) {
      console.warn(`Failed to write back Claude session name for "${providerSessionId}":`, error);
    }
  }

  /**
   * Extracts session metadata from one Claude JSONL session file.
   */
  private async processSessionFile(
    filePath: string,
    nameMap: Map<string, string>
  ): Promise<ParsedSession | null> {
    const parsed = await extractFirstValidJsonlData(filePath, (rawData) => {
      const data = rawData as Record<string, unknown>;
      const sessionId = typeof data.sessionId === 'string' ? data.sessionId : undefined;
      const projectPath = typeof data.cwd === 'string' ? data.cwd : undefined;

      if (!sessionId || !projectPath) {
        return null;
      }

      return {
        sessionId,
        projectPath,
      };
    });

    if (!parsed) {
      return null;
    }

    // App-created sessions are keyed by an app id, so disk-discovered provider
    // ids must be resolved through the provider-id mapping first.
    const existingSession = sessionsDb.getSessionByProviderSessionId(parsed.sessionId)
      ?? sessionsDb.getSessionById(parsed.sessionId);
    const existingSessionName = existingSession?.custom_name ?? undefined;

    // The transcript is append-only and both a native CLI rename
    // (`claude -n <name>`/`/rename`) and our own write-back path (see
    // `writeBackCustomName`) append the same `custom-title` event shape, so
    // "the latest title event in the file" is always the freshest name
    // regardless of which side produced it. Re-deriving this on every pass
    // (instead of freezing once `custom_name` is set) is what makes renames
    // flow in both directions.
    let sessionName = await this.extractSessionAiTitleFromEnd(filePath, parsed.sessionId);
    if (!sessionName) {
      sessionName = nameMap.get(parsed.sessionId);
    }
    if (!sessionName) {
      sessionName = existingSessionName;
    }

    return {
      ...parsed,
      sessionName: normalizeSessionName(sessionName, 'Untitled Claude Session'),
    };
  }

  private async extractSessionAiTitleFromEnd(
    filePath: string,
    sessionId: string
  ): Promise<string | undefined> {
    try {
      const content = await readFile(filePath, 'utf8');
      const lines = content.split(/\r?\n/);

      // `custom-title` is a sticky, explicit rename (native `/rename`/`-n`, or
      // this app's own write-back) and must win even if `ai-title`/`last-prompt`
      // events were appended later — Claude Code appends a fresh `last-prompt`
      // on every turn and occasionally a fresh `ai-title` as the user keeps
      // chatting after a rename, so "latest event in the file regardless of
      // kind" would silently revert a user's chosen name. Precedence is by
      // event kind (custom-title > ai-title > last-prompt), using the latest
      // occurrence WITHIN each kind.
      let customTitle: string | undefined;
      let aiTitle: string | undefined;
      let lastPrompt: string | undefined;

      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index]?.trim();
        if (!line) {
          continue;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }

        const data = parsed as Record<string, unknown>;
        const eventType = typeof data.type === 'string' ? data.type : undefined;
        const eventSessionId = typeof data.sessionId === 'string' ? data.sessionId : undefined;
        if (eventSessionId !== sessionId) {
          continue;
        }

        if (!customTitle && eventType === 'custom-title') {
          const value = typeof data.customTitle === 'string' ? data.customTitle : undefined;
          if (value?.trim()) {
            customTitle = value;
          }
        } else if (!aiTitle && eventType === 'ai-title') {
          const value = typeof data.aiTitle === 'string' ? data.aiTitle : undefined;
          if (value?.trim()) {
            aiTitle = value;
          }
        } else if (!lastPrompt && eventType === 'last-prompt') {
          const value = typeof data.lastPrompt === 'string' ? data.lastPrompt : undefined;
          if (value?.trim()) {
            lastPrompt = value;
          }
        }

        if (customTitle && aiTitle && lastPrompt) {
          break;
        }
      }

      return customTitle || aiTitle || lastPrompt;
    } catch {
      // Ignore missing/unreadable files so sync can continue.
    }

    return undefined;
  }
}
