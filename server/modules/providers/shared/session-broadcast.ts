import path from 'node:path';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { broadcast } from '@/modules/events/index.js';
import { generateDisplayName } from '@/shared/workspace-paths.js';

/**
 * Publishes a `session_upserted` realtime event for one app session.
 *
 * Relocated out of the websocket module (was
 * `chat-run-registry.service.ts#broadcastCanonicalSessionUpsert`) so
 * `provider.routes.ts` can call it without providers depending on
 * websocket — that direct dependency is what closed a cycle back through
 * `modules/websocket/index.ts`. Publishing through
 * `@/modules/events/index.js#broadcast` instead of iterating
 * `connectedClients` directly keeps this leaf-safe: the websocket hub
 * registers the one real send-to-all-open-clients handler at startup, same
 * as every other cross-module broadcast in this codebase. Wire bytes are
 * unchanged.
 */
export async function broadcastCanonicalSessionUpsert(appSessionId: string): Promise<void> {
  const row = sessionsDb.getSessionById(appSessionId);
  if (!row || row.isArchived) {
    return;
  }

  const projectPath = row.project_path;
  const project = projectPath ? projectsDb.getProjectPath(projectPath) : null;
  const displayName = project?.custom_project_name?.trim()
    ? project.custom_project_name
    : await generateDisplayName(path.basename(projectPath ?? '') || (projectPath ?? ''), projectPath);

  broadcast({
    kind: 'session_upserted',
    sessionId: row.session_id,
    providerSessionId: row.provider_session_id,
    provider: row.provider,
    session: {
      id: row.session_id,
      summary: row.custom_name || '',
      messageCount: 0,
      lastActivity: row.updated_at ?? row.created_at ?? new Date().toISOString(),
      activeLeaf: row.active_leaf === 1,
    },
    project: project
      ? {
        projectId: project.project_id,
        path: project.project_path,
        fullPath: project.project_path,
        displayName,
        isStarred: Boolean(project.isStarred),
      }
      : null,
    timestamp: new Date().toISOString(),
  });
}
