# Capability: Edit Sent Prompt (Conversation Fork)

## Description

Lets the user edit a prompt they already sent and re-send it, forking the conversation in place at that point rather than appending a correction turn. The fork is implemented on top of the Claude Agent SDK's own resume mechanics (`resume` + `resumeSessionAt` + `forkSession`), so the branch is a first-class Claude session with its own transcript — cloudcli does not hand-edit JSONL. Only Claude sessions support this; Cursor, Codex, and OpenCode have no equivalent resume-at-message primitive.

Code changes made by the tool calls in the original branch are **never reverted** by a fork. Forking only rewinds the *conversation* the model sees; if the user wants to undo file edits, that is a Git operation via the Git panel, not part of this feature.

## Actors

- **End-user developer** — Clicks Edit on a previously sent prompt, changes its text, and re-sends it.
- **`MessageComponent`** — Renders the Edit control (pencil icon plus an "Edit" label) on eligible user turns and calls back into the composer. The control is always visible, never hover-gated: a hover-only affordance is unreachable on touch and undiscoverable for anyone who does not already know the feature exists.
- **The composer (`useChatComposerState`)** — Loads the edited text into the input with a Git-note banner, and re-submits with `editAtMessageUuid` set.
- **`chat-websocket.service.ts`** — Validates the session is a Claude session with a transcript, locates the resume point, and dispatches the fork.
- **`findForkResumePoint`** (`claude-fork.provider.ts`) — Scans the session's JSONL transcript for the assistant-message uuid immediately preceding the edited user message.
- **Claude Agent SDK** — Performs the actual resume-and-fork via `resume` + `resumeSessionAt` + `forkSession`, producing a new provider session id and a new transcript file.
- **cloudcli SQLite (`sessions` table)** — Records the fork relationship (`fork_root_session_id`, `forked_from_session_id`, `forked_at_message_uuid`, `active_leaf`) so branches can be listed and switched without re-parsing every transcript.
- **`BranchSwitcher`** — Renders a pair of `‹ ›` chevrons at a fork point once more than one branch exists there, plus an `sr-only` live region announcing which version is showing. There is no visible counter: the position is announced to assistive tech rather than printed, so the chevrons stay a compact control with a single meaning — move between versions.
- **`SidebarSessionItem`** — Shows one row per fork cluster (the active leaf). The row carries no branch affordance; branches are reached from the switcher at the fork point in the transcript.

## Trigger

- The user clicks the Edit control on a sent user-turn bubble in a Claude session that is not currently streaming.

## Flow

1. `canEditPrompt` (`provider === 'claude' && !isProcessing`) gates whether the Edit control renders — hidden while a run is in progress. The conversation's FIRST user message never shows the icon (`firstUserMessageUuid` in `branchAnchors.ts`, pagination-aware): with no assistant turn before it there is no resume anchor, and the SDK would copy the full history instead of truncating.
2. Clicking Edit loads that message's text into the composer, along with the banner: *"Editing a sent prompt — the new branch only rewinds the conversation. Code changes after this point are kept (see the Git tab)."*
3. The user edits the text and sends. The composer includes `options.editAtMessageUuid` (the uuid of the message being edited) in the `chat.send` WS envelope, alongside the edited prompt text.
4. `chat-websocket.service.ts` rejects the request with a `protocol_error` (`code: 'FORK_FAILED'`) if the session isn't Claude, or has no transcript yet.
5. `findForkResumePoint` streams the transcript JSONL looking for the edited message's uuid, tracking the last-seen assistant uuid (`RESUME_POINT_RULE = 'preceding-assistant-uuid'`). It returns that assistant uuid as `resumeSessionAt`; a `null` result (edited message was the first prompt) is rejected with `FORK_FAILED` ("start a new session instead"), since omitting `resumeSessionAt` would copy the full history rather than truncate. Any other transcript problem also surfaces as `FORK_FAILED`.
6. The hub invokes `queryClaudeSDK` with `resume` (the original provider session id), `resumeSessionAt` (the resume point), and `forkSession: true`, plus the new prompt text.
7. The SDK creates a new provider session and transcript file that shares history up to the resume point, then continues with the edited prompt. During the new run, the old message tail is hidden client-side and the new prompt streams in its place.
8. **Mid-stream**, the instant the SDK announces the fork's provider session id, `recordProviderSessionId` records the fork edge in SQLite (`forked_from_session_id`, `forked_at_message_uuid`, `fork_root_session_id` propagated from the root), marks the new session `active_leaf = 1`, demotes the sibling, and emits `branch_created`. This is deliberately not deferred to `complete` — the client needs to adopt the branch while it is still streaming. The consequence to keep in mind: a run that errors or is aborted *after* the id lands still leaves the branch row inserted and the cluster's active leaf already moved.
9. `useChatRealtimeHandlers` reacts to `branch_created` to update the view and to `FORK_FAILED` protocol errors by restoring the prior view with the edited text still in the composer (no data lost on failure).
10. At the fork point, `BranchSwitcher` shows `‹ ›`; either chevron calls `POST /sessions/:id/activate-branch` to switch which sibling is displayed, in place, without navigating away. Both ends stay focusable (`aria-disabled`, not `disabled`) so keyboard focus is not dropped on reaching the first or last version, and the live region announces the new position.
11. `branch_created` goes only to the socket that started the run. Every *other* tab converges through the separate `session_upserted` broadcast, which is what moves their sidebar row — so a "my other tab did not update" report is a `session_upserted` problem, not a missed `branch_created` subscription.

## Output

- A new Claude session (new provider session id, new transcript file) that shares conversation history up to the resume point and diverges from there.
- Sidebar shows **one row per fork cluster** — the current active leaf — instead of one row per branch, and carries no branch-specific affordance.
- A pair of `‹ ›` chevrons rendered inline at each fork point in the message list, with the current position announced through an `sr-only` live region rather than printed.
- On failure: a `FORK_FAILED` protocol error, the original view left intact, and the user's edited text preserved in the composer so nothing is lost.

## Fork Graph Persistence

- Stored entirely in cloudcli's own SQLite `sessions` table (`server/modules/database/schema.ts`), not derived from transcripts at read time:
  - `fork_root_session_id TEXT` — the original, never-forked ancestor of the cluster.
  - `forked_from_session_id TEXT` — the immediate parent branch.
  - `forked_at_message_uuid TEXT` — the fork anchor: the uuid of the assistant message the branch resumed from. Unlike the edited user message's uuid (which exists only in the parent transcript), the anchor is copied into every sibling transcript, so the branch switcher can render in any branch. Always set for rows created by this flow (first-prompt edits, which would have no anchor, are rejected up front); the column stays nullable for schema simplicity.
  - `active_leaf BOOLEAN DEFAULT 1` — which sibling is currently displayed for the cluster; exactly one leaf per cluster is active. Deleting or archiving the active leaf promotes the most recently touched surviving sibling in the same transaction, and the sidebar query falls back to that same row if it ever meets a cluster with no leaf at all — without both, losing the leaf would hide the entire cluster, original conversation included.
- `GET /sessions/:sessionId/branches` returns all branches in a cluster (filtered to those whose transcript file still exists on disk).
- `POST /sessions/:sessionId/activate-branch` flips `active_leaf` to the given session and demotes its siblings.
- **Sessions forked outside cloudcli** (e.g. via `claude --resume` + manual `forkSession` from the CLI directly) have no row with these columns populated and simply appear as ordinary, unrelated sessions — cloudcli only builds the fork graph for forks it initiated itself.

## Technical Mapping

- **Frontend UI:** `src/components/chat/view/subcomponents/MessageComponent.tsx` (always-visible Edit control, `canEditPrompt` gate), `BranchSwitcher.tsx` (`‹ ›` chevrons + `sr-only` live region)
- **Frontend composer:** `src/components/chat/hooks/useChatComposerState.ts` (loads edited text + banner, sets `editAtMessageUuid`)
- **Frontend realtime:** `src/components/chat/hooks/useChatRealtimeHandlers.ts` (`branch_created` handling, `FORK_FAILED` recovery)
- **i18n:** `src/i18n/locales/en/chat.json` (`input.editSentPrompt.banner` — Git-note text; `branch.*` — switcher labels)
- **Backend WS entry:** `server/modules/websocket/services/chat-websocket.service.ts` (validates Claude-only + transcript existence, raises `FORK_FAILED`)
- **Backend fork logic:** `server/modules/providers/list/claude/claude-fork.provider.ts` (`findForkResumePoint`, `ForkResumePointError`)
- **Backend run lifecycle:** `server/modules/websocket/services/chat-run-registry.service.ts` (emits `branch_created`)
- **Backend SDK wrapper:** `server/claude-sdk.js` (`queryClaudeSDK` with `resume` + `resumeSessionAt` + `forkSession`)
- **Backend REST routes:** `server/modules/providers/provider.routes.ts` (`GET /sessions/:sessionId/branches`, `POST /sessions/:sessionId/activate-branch`)
- **Backend persistence:** `server/modules/database/schema.ts` (fork columns), `server/modules/database/migrations.ts` (`addForkColumns`), `server/modules/database/repositories/sessions.db.ts` (`getClusterBranches`, `activateBranch`)
- **Shared types:** `server/shared/types.ts` (`branch_created` event kind)

## Dependencies

- **Chat & Agent Streaming** — The composer, message list, and WS envelope this feature extends.
- **Provider Integration** — Only the Claude provider implements resume-at-message; the capability is unavailable for Cursor, Codex, OpenCode.
- **Session Management** — The sessions-watcher and session list must tolerate multiple sibling sessions per cluster and surface only the active leaf.
- **Authentication & Security** — Branch REST routes are authenticated like all other session routes.
