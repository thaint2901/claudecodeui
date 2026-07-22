import os from 'node:os';
import path from 'node:path';
import { open, readFile, stat } from 'node:fs/promises';

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
import type { ProviderSessionId } from '@/shared/types.js';

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
   * the same on-disk event `claude -n <name>`/`/rename` produces. This
   * updates terminal-title and explicit-id `claude --resume <id>` surfaces —
   * it does NOT add the session to (or relabel it within) the interactive
   * `claude --resume` picker, since Claude Code excludes Agent-SDK-origin
   * sessions (i.e. every session this app creates) from that picker
   * regardless of title.
   *
   * `projectPath`, when passed, scopes `renameSession`'s lookup to that
   * project directory instead of searching every project under
   * `~/.claude/projects`.
   *
   * Best-effort and logged, not silent: if the session has no transcript on
   * disk yet (e.g. an app-created session that hasn't produced a Claude Code
   * process run yet), `renameSession` rejects with a "not found" error that
   * is logged at `warn` (expected/routine) and swallowed; any other error is
   * logged at `error` (likely a real regression) and still swallowed — in
   * both cases the rename API call itself never fails, since the DB name
   * remains the source of truth for the webui regardless of write-back
   * outcome.
   */
  async writeBackCustomName(providerSessionId: ProviderSessionId, customName: string, projectPath?: string): Promise<void> {
    try {
      await renameSession(providerSessionId, customName, projectPath ? { dir: projectPath } : undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/not found/i.test(message)) {
        console.warn(`Skipped Claude session name write-back for "${providerSessionId}" (session not found on disk yet): ${message}`);
      } else {
        console.error(`Failed to write back Claude session name for "${providerSessionId}"`, { error: message });
      }
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

  // Bounds the fast-path read to the last N bytes of the transcript. Most
  // sessions either were renamed recently (the `custom-title` event lands
  // within this window) or were never renamed at all (no title event
  // anywhere) — this budget makes the former cheap without ever risking the
  // correctness bug this precedence logic exists to fix (see below).
  private static readonly TITLE_SCAN_TAIL_BYTES = 65536;

  /**
   * `custom-title` is a sticky, explicit rename (native `/rename`/`-n`, or
   * this app's own write-back) and must win even if `ai-title`/`last-prompt`
   * events were appended later — Claude Code appends a fresh `last-prompt`
   * on every turn and occasionally a fresh `ai-title` as the user keeps
   * chatting after a rename, so "latest event in the file regardless of
   * kind" would silently revert a user's chosen name. Precedence is by event
   * kind (custom-title > ai-title > last-prompt), using the latest
   * occurrence WITHIN each kind.
   *
   * Scans backward through `lines`, filling `state`'s still-unset fields.
   * Returns true once `customTitle` has been found (the only kind that can
   * "unlock" an early exit safely — see `extractSessionAiTitleFromEnd`).
   */
  private scanLinesForTitleEvents(
    lines: string[],
    sessionId: string,
    state: { customTitle?: string; aiTitle?: string; lastPrompt?: string }
  ): boolean {
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

      if (!state.customTitle && eventType === 'custom-title') {
        const value = typeof data.customTitle === 'string' ? data.customTitle : undefined;
        if (value?.trim()) {
          state.customTitle = value;
        }
      } else if (!state.aiTitle && eventType === 'ai-title') {
        const value = typeof data.aiTitle === 'string' ? data.aiTitle : undefined;
        if (value?.trim()) {
          state.aiTitle = value;
        }
      } else if (!state.lastPrompt && eventType === 'last-prompt') {
        const value = typeof data.lastPrompt === 'string' ? data.lastPrompt : undefined;
        if (value?.trim()) {
          state.lastPrompt = value;
        }
      }

      // `customTitle` is the only kind that can safely short-circuit: once
      // found, it's the latest occurrence of the highest-precedence kind
      // seen so far, and nothing later in the scan (earlier in the file)
      // could outrank it. Finding `aiTitle`/`lastPrompt` does NOT justify an
      // early exit here — a `customTitle` could still appear earlier in this
      // same buffer, and stopping before checking would silently miss it
      // (exactly the bug this precedence logic exists to prevent).
      if (state.customTitle) {
        return true;
      }
    }

    return Boolean(state.customTitle);
  }

  private async extractSessionAiTitleFromEnd(
    filePath: string,
    sessionId: string
  ): Promise<string | undefined> {
    const state: { customTitle?: string; aiTitle?: string; lastPrompt?: string } = {};

    try {
      const { size } = await stat(filePath);
      const tailBudget = ClaudeSessionSynchronizer.TITLE_SCAN_TAIL_BYTES;

      if (size > tailBudget) {
        // Fast path: read only the tail. A custom-title found here is always
        // correct (it's the highest-precedence kind and this is the latest
        // occurrence of anything in the file). If the tail has no
        // custom-title, we cannot conclude there isn't one further back —
        // unlike the interactive CLI's own known tail-window bug (see
        // upstream anthropics/claude-code#27202/#33165), we do not guess:
        // fall through to a full scan rather than risk resurrecting the
        // exact "custom rename silently reverted" bug this precedence logic
        // was written to fix.
        const handle = await open(filePath, 'r');
        try {
          const buffer = Buffer.alloc(tailBudget);
          await handle.read(buffer, 0, tailBudget, size - tailBudget);
          const tailLines = buffer.toString('utf8').split(/\r?\n/);
          if (this.scanLinesForTitleEvents(tailLines, sessionId, state)) {
            return state.customTitle;
          }
        } finally {
          await handle.close();
        }
      }

      // Full scan: either the file fits within the tail budget, or the tail
      // didn't contain a custom-title and we need to check the rest of the
      // file for one (ai-title/last-prompt, if already found above, are kept
      // as-is — the tail already holds their latest occurrence).
      const content = await readFile(filePath, 'utf8');
      this.scanLinesForTitleEvents(content.split(/\r?\n/), sessionId, state);

      return state.customTitle || state.aiTitle || state.lastPrompt;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Failed to read Claude transcript for title extraction (session "${sessionId}")`, { error: message });
    }

    return undefined;
  }
}
