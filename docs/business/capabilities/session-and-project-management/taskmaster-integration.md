# Capability: TaskMaster Integration

## Description

Detects whether a project has TaskMaster installed and exposes per-project task state (parse `tasks.json`), CRUD operations, dependency-aware expansion, and AI-driven research and complexity analysis. Real-time updates broadcast over WebSocket (`taskmaster-project-updated`, `taskmaster-tasks-updated`).

## Actors

- **End user** — Creates, edits, and moves tasks on the kanban board.
- **The agent** — Generates tasks from a PRD.
- **The TaskMaster REST routes** — Own the operations.
- **The WebSocket broadcast** — Notifies connected clients of updates.

## Trigger

- The user opens the Tasks tab in a project.
- The user runs TaskMaster setup.
- The agent generates tasks from a PRD.
- A task is created, updated, or moved.

## Flow (Setup Detection)

1. The frontend calls `GET /api/taskmaster/has-taskmaster?projectPath=...`.
2. The service checks for a `.taskmaster` directory and `tasks.json`.
3. The result determines whether the setup wizard is shown.

## Flow (CRUD)

1. The user creates / updates / moves a task on the kanban.
2. The frontend calls the appropriate TaskMaster endpoint.
3. The service reads / writes `tasks.json`.
4. A WebSocket broadcast notifies connected clients.

## Flow (Agent-Generated Tasks)

1. The agent generates tasks from a PRD via the LLM.
2. The service writes them to `tasks.json`.
3. A WebSocket broadcast updates the kanban in real time.

## Output

- A kanban board per project.
- Real-time updates across all connected clients.
- A PRD-to-tasks flow.

## Technical Mapping

- **Backend route:** `server/routes/taskmaster.js`
- **Backend helper:** `server/utils/taskmaster-websocket.js`
- **Backend detector:** `server/utils/mcp-detector.js`
- **Frontend:** `src/components/task-master/view/TaskMasterPanel.tsx`
- **Frontend context:** `src/contexts/TaskMasterContext.tsx`, `TasksSettingsContext.tsx`
- **PRD editor:** `src/components/prd-editor/`

## Dependencies

- **Session & Project Management** — Project context.
- **Chat & Agent Streaming** — Agent-driven PRD → tasks flow.
- **Database Layer** — Project lookup.
