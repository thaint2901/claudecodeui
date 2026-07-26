import { createReadStream } from 'node:fs';
import readline from 'node:readline';

export class ForkResumePointError extends Error {
  readonly code = 'RESUME_POINT_NOT_FOUND';
  constructor(message: string) {
    super(message);
    this.name = 'ForkResumePointError';
  }
}

/**
 * Scans one Claude transcript for the resume point of an edit-prompt fork:
 * the uuid of the assistant message immediately preceding the edited user
 * message (RESUME_POINT_RULE = 'preceding-assistant-uuid', see spike results
 * in the design spec). `null` means the edited message is the first prompt.
 */
export async function findForkResumePoint(
  jsonlPath: string,
  providerSessionId: string,
  editAtMessageUuid: string,
): Promise<{ resumeSessionAt: string | null }> {
  const stream = createReadStream(jsonlPath, 'utf8');
  const rl = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  let lastResumableUuid: string | null = null;
  try {
    for await (const rawLine of rl) {
      if (!rawLine.trim()) continue;
      let entry: { sessionId?: string; uuid?: string; type?: string };
      try {
        entry = JSON.parse(rawLine);
      } catch {
        continue; // tolerate partial/corrupt trailing lines
      }
      if (entry.sessionId !== providerSessionId || !entry.uuid) continue;
      if (entry.uuid === editAtMessageUuid) {
        return { resumeSessionAt: lastResumableUuid };
      }
      // RESUME_POINT_RULE: only assistant uuids are valid resume anchors.
      // If the spike concluded 'preceding-any-uuid', drop this type check.
      if (entry.type === 'assistant') {
        lastResumableUuid = entry.uuid;
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  throw new ForkResumePointError(
    `Message ${editAtMessageUuid} not found in transcript for session ${providerSessionId}`,
  );
}
