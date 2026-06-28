# Capability: Project CRUD

## Description

Create, rename, archive, restore, star, and hard-delete projects. Display name resolution prefers the custom name, then the `package.json` name, then the basename. Project paths are normalized and validated against `WORKSPACES_ROOT`.

## Actors

- **End user** — Creates, renames, archives, deletes projects.
- **The projects module** — Owns the CRUD operations.
- **The sidebar** — Renders the list and provides actions.
- **The wizard** — Walks through project creation.

## Trigger

- The user opens the Project Creation Wizard and submits.
- The user clicks a project action in the sidebar context menu.
- The user archives or deletes a project.

## Flow (Create)

1. The user opens the Project Creation Wizard.
2. The user picks a local folder, optionally authenticates with GitHub, and configures the new project.
3. The frontend POSTs the new project to `/api/projects`.
4. The projects module validates the path, creates a `projects` row with a UUID `project_id`, and resolves the display name.
5. The new project appears in the sidebar.

## Flow (Rename / Star / Archive)

1. The user clicks the project action in the sidebar.
2. The frontend calls the appropriate endpoint.
3. The projects module updates the row.
4. The sidebar re-renders.

## Flow (Hard-Delete)

1. The user confirms hard-delete in the sidebar.
2. The project-delete service removes:
   - The jsonl transcripts on disk
   - The `sessions` rows for the project
   - The `projects` row itself
3. The sidebar re-renders.

## Output

- A new / updated / archived / deleted project.
- A consistent display name.
- (On hard-delete) Cleaned transcripts and rows.

## Technical Mapping

- **Backend routes:** `server/modules/projects/projects.routes.ts`
- **Backend services:**
  - `project-management.service.ts`
  - `project-delete.service.ts`
  - `project-star.service.ts`
  - `project-clone.service.ts`
  - `projects-has-taskmaster.service.ts`
- **Backend repo:** `server/modules/database/repositories/projects.db.ts`
- **Frontend sidebar:** `src/components/sidebar/view/subcomponents/SidebarProjectItem.tsx`
- **Frontend wizard:** `src/components/project-creation-wizard/ProjectCreationWizard.tsx`

## Dependencies

- **Database Layer** — `projects` table.
- **Authentication & Security** — User identity.
- **Filesystem path validation** — `validateWorkspacePath`.
