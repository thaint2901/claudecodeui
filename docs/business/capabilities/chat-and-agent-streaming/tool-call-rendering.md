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
   - **Sub-agent (Agent / Task tool)** — A `SubagentContainer` block: a live "Currently: <tool>" progress line while running, then a completion line with the tool count and a trimmed result preview. Clicking "View transcript" opens `SubagentTranscriptPanel`, a right-anchored slide-over drawer showing the subagent's full transcript at main-session fidelity — text, thinking, nested tool calls (including nested subagents, which recurse through the same container), and per-tool error boxes. Edits and writes inside the drawer render the same diff viewer as the main pane.
   - **Todo list / Task list** — Structured kanban-style view.
   - **Plan** — PlanDisplay with approve/reject.
   - **AskUserQuestion** — Interactive panel with multi-choice options.
4. The user interacts (expands, copies, answers, opens/closes the subagent transcript drawer).
5. For interactive prompts (AskUserQuestion, plan approval), the user's response is sent back as a `chat.permission-response` (or `chat.tool-response`) envelope.

## Sub-agent Result Handling

The Agent tool's `tool_result` carries a trailing runtime-metadata block (agent id, usage) that is not meant for display. `extractSubagentText` strips it everywhere the result text is read — the compact "Completed" line in `SubagentContainer` and the drawer's own Result box. The drawer only renders its Result box when the transcript doesn't already end with the subagent's own final text message (`transcriptEndsWithText`), so the same text is never shown twice; when it does duplicate, error results still fall back to the per-tool error boxes shown above each failing call. If a subagent completed but no transcript could be located for it (e.g. its agent file wasn't found in this session or any sibling session directory), the drawer shows "No transcript available for this subagent." instead of an empty pane. The main chat view also suppresses the separate "Subagent result" section that would otherwise appear below a container message — errors are the one exception and still surface there.

A fork-mode subagent's `tool_result` is the SDK's own background-launch acknowledgment ("Async agent launched successfully…"), not the subagent's real output, since fork subagents always run in the background; `SubagentContainer` recognizes and replaces that boilerplate with a neutral "Running in background…" status rather than showing it as the result.

## Output

- A rendered tool output block in the chat history.
- A user decision fed back to the agent for interactive prompts.
- Persisted tool output for the session.
- For Agent/Task tool calls, a persisted `parentToolUseId` linking each nested tool call to the container that spawned it, so a page reload can rebuild the same subagent grouping (see Technical Mapping).

## Technical Mapping

- **Frontend dispatcher:** `src/components/chat/tools/ToolRenderer.tsx`
- **Frontend configs:** `src/components/chat/tools/configs/toolConfigs.ts`, `permissionPanelRegistry.ts`
- **Frontend components:**
  - `components/ToolDiffViewer.tsx`
  - `components/PlanDisplay.tsx`
  - `components/SubagentContainer.tsx` (container block, `extractResultText`, background-launch-ack suppression)
  - `components/SubagentTranscriptPanel.tsx` (slide-over drawer, focus trap, Result-box dedupe)
  - `src/components/chat/utils/subagentToolNames.ts` (`extractSubagentText`, `transcriptEndsWithText`)
  - `components/ContentRenderers/*` (FileList, Markdown, QuestionAnswer, TaskList, Text, TodoList)
  - `components/InteractiveRenderers/AskUserQuestionPanel.tsx`
- **Backend tool approval:** `server/claude-sdk.js` (`canUseTool` for Claude)
- **Backend subagent linkage:** `server/modules/providers/list/claude/claude-sessions.provider.ts` (stamps `parentToolUseId` from `toolUseResult.agentId`; `resolveAgentFilePath` locates a forked session's inherited subagent transcript files across sibling session directories in the same project)

## Dependencies

- **Chat & Agent Streaming** — The event stream.
- **Provider Integration** — Provider-specific tool call normalization.
- **Authentication & Security** — The tool permission model.
