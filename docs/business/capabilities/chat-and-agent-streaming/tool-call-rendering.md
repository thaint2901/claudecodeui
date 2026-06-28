# Capability: Tool Call Rendering

## Description

Renders every tool call the agent makes — file reads, edits, bash, web searches, sub-agents, todo lists, plans, AskUserQuestion prompts — with appropriate UX for each. Users can expand, collapse, copy, and review the structured output of every tool.

## Actors

- **End-user developer** — Reviews the agent's actions.
- **The provider runtime** — Emits tool calls as part of the stream.
- **The chat pane** — Dispatches to the right renderer.
- **The agent (AskUserQuestion)** — Receives the user's answer.

## Trigger

- A `tool_call` (or provider-equivalent) event arrives in the chat stream.

## Flow

1. The provider runtime emits a tool call event with a tool name and input.
2. The chat pane receives the event and dispatches to `ToolRenderer` (`src/components/chat/tools/ToolRenderer.tsx`).
3. `ToolRenderer` looks up the tool's renderer config and renders the structured output:
   - **Read / Edit** — Diff viewer with syntax highlighting.
   - **Bash** — Collapsible output with copy / expand.
   - **Web** — Search results list.
   - **Sub-agent** — Recursive container for nested tool calls.
   - **Todo list / Task list** — Structured kanban-style view.
   - **Plan** — PlanDisplay with approve/reject.
   - **AskUserQuestion** — Interactive panel with multi-choice options.
4. The user interacts (expands, copies, answers).
5. For interactive prompts (AskUserQuestion, plan approval), the user's response is sent back as a `chat.permission-response` (or `chat.tool-response`) envelope.

## Output

- A rendered tool output block in the chat history.
- A user decision fed back to the agent for interactive prompts.
- Persisted tool output for the session.

## Technical Mapping

- **Frontend dispatcher:** `src/components/chat/tools/ToolRenderer.tsx`
- **Frontend configs:** `src/components/chat/tools/configs/toolConfigs.ts`, `permissionPanelRegistry.ts`
- **Frontend components:**
  - `components/ToolDiffViewer.tsx`
  - `components/PlanDisplay.tsx`
  - `components/SubagentContainer.tsx`
  - `components/ContentRenderers/*` (FileList, Markdown, QuestionAnswer, TaskList, Text, TodoList)
  - `components/InteractiveRenderers/AskUserQuestionPanel.tsx`
- **Backend tool approval:** `server/claude-sdk.js` (`canUseTool` for Claude)

## Dependencies

- **Chat & Agent Streaming** — The event stream.
- **Provider Integration** — Provider-specific tool call normalization.
- **Authentication & Security** — The tool permission model.
