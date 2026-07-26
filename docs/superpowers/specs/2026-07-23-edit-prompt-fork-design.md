# Edit Prompt → Conversation Fork (Claude provider)

**Date:** 2026-07-23
**Status:** Approved in brainstorming; pending spec review
**Scope:** Claude provider only. Conversation-level fork only — no code/file revert.

## 1. Summary

Let the user edit a previously sent prompt in the chat view. Sending the edited
prompt forks the conversation at that point (ChatGPT-style): the new branch
replaces the view in place, the old branch is preserved, and a `< 1/2 >`
branch switcher appears at the fork point. Code changes made by the agent are
never reverted — users are pointed to the existing Git panel instead.

### Decisions locked during brainstorming

| Decision | Choice |
|---|---|
| UX after fork | In-place view replacement + `< 1/2 >` branch switcher |
| Sidebar | One row per conversation cluster; non-active branches hidden |
| Scope of actions | Edit user prompts only. No "Regenerate" on assistant replies |
| Other providers | Hide the ✏️ button entirely (Claude-only feature) |
| Code revert | Not included. Small note in composer edit mode pointing to Git tab |
| Branch tree location | Approach A: session-level fork graph in cloudcli SQLite; no `parentUuid` parsing, no message-tree table |

### Why Approach A works

The Agent SDK's `forkSession` copies the full history up to the fork point
into the new branch's own JSONL transcript. Displaying any branch therefore
requires **no change to the existing message-loading pipeline** — each branch
is a normal session. Only the *relationships between sessions* (which branch
forked from which, at which message, which is active) need storing, and SQLite
already manages sessions. This also avoids depending on the JSONL internal
format, which official docs warn changes between versions.

## 2. SDK facts (verified)

Verified against the pinned `@anthropic-ai/claude-agent-sdk` **0.3.165**
(`node_modules/.../sdk.d.ts`), official TS SDK reference, and context7 docs:

- `resume: string` — session ID to resume (already used by cloudcli).
- `forkSession: boolean` — with `resume`, forks to a new session ID; the
  original session is untouched.
- `resumeSessionAt: string` — with `resume`, resumes messages **up to and
  including** the message with this UUID. Confirmed by the spike in §7:
  `RESUME_POINT_RULE = 'preceding-assistant-uuid'` — the UUID must be the
  preceding *assistant* message's uuid (`SDKAssistantMessage.uuid`, per the
  doc comment). A *user* message uuid does not error or get ignored, but
  "up to and including" is taken literally on that user turn: the original
  user message stays in the forked history and the new prompt is appended
  right after it (no assistant reply is synthesized for the original turn) —
  the opposite of what "edit this prompt" needs, since the edited prompt's
  original text is not removed.
- The new session ID is announced on the system `init` message
  (`message.session_id`) and on the result message.
- Transcript message UUIDs already flow to the frontend: the JSONL parser uses
  `raw.uuid` as `NormalizedMessage.id`
  (`server/modules/providers/list/claude/claude-sessions.provider.ts:351`).

Not used (out of scope): `enableFileCheckpointing` / `rewindFiles` — file
revert is deliberately excluded because it cannot undo Bash-driven changes and
Git covers this better (cloudcli already has a Git panel).

## 3. Database schema

Migration adding four nullable/default columns to `sessions`
(`server/modules/database/schema.ts:100`, plus a migration in
`server/modules/database/migrations.ts`):

```sql
ALTER TABLE sessions ADD COLUMN fork_root_session_id TEXT;      -- session_id of the cluster root; NULL = never forked
ALTER TABLE sessions ADD COLUMN forked_from_session_id TEXT;    -- direct parent branch; NULL on the root
ALTER TABLE sessions ADD COLUMN forked_at_message_uuid TEXT;    -- resume anchor: uuid of the ASSISTANT message preceding the edited prompt
ALTER TABLE sessions ADD COLUMN active_leaf BOOLEAN DEFAULT 1;  -- currently displayed branch of the cluster
CREATE INDEX IF NOT EXISTS idx_sessions_fork_root ON sessions(fork_root_session_id);
```

Semantics:

- **Cluster** = all rows sharing `fork_root_session_id`. When a session is
  forked for the first time, the root's `fork_root_session_id` is set to its
  own `session_id`.
- **Invariant:** each cluster has exactly one row with `active_leaf = 1`.
  Switching branches updates two rows in one transaction.
- **Sidebar** lists only `active_leaf = 1` rows (never-forked sessions have
  `active_leaf = 1` by default, so behavior is unchanged for them).
- **Switcher at message X:** siblings = cluster sessions with
  `forked_at_message_uuid = X`, plus the branch that contains the original
  message X. Ordered by `created_at`.
- Rename/archive/delete operate on the whole cluster via
  `fork_root_session_id`.
- Accepted limitation: fork relationships exist only in cloudcli's DB. Forks
  created outside cloudcli (`claude --fork-session`) appear as ordinary
  sessions. Losing the DB loses the tree, not the transcripts.

## 4. Server flow

1. **WebSocket message** (existing chat path): client sends
   `{ type: 'chat', content: <edited prompt>, options: { editAtMessageUuid } }`.
2. **`chat-websocket.service.ts`** (near the existing sessionId lookup,
   `server/modules/websocket/services/chat-websocket.service.ts:196-205`):
   when `editAtMessageUuid` is present, scan the current session's JSONL for
   the message **immediately preceding** the edited message; pass its uuid as
   the resume point. Preceding-message rule per the spike (§7): the
   immediately preceding **assistant** message's uuid. Edge case: editing the
   **first** prompt is **rejected** (`FORK_FAILED`) — there is no preceding
   assistant turn to anchor on, and omitting `resumeSessionAt` makes the SDK
   copy the FULL history into the branch (spike-verified), which is wrong
   "edit" semantics. The UI additionally hides the ✏️ button on the first
   user message; the server guard covers stale/non-UI clients.
3. **`mapCliOptionsToSDK()`** (`server/claude-sdk.js:160-237`) additions:
   `resumeSessionAt` passthrough and `forkSession: true` when forking.
4. **Branch row creation:** when the SDK announces the new `session_id`
   (existing init-message handling), create the new `sessions` row with fork
   metadata and flip `active_leaf` from the parent branch to the new one, in a
   single transaction in the sessions repository. The DB row is written the
   moment the SDK announces the ID, mid-stream. **As shipped, that means a run
   which errors or is aborted *after* the id lands still leaves the branch row
   inserted and the cluster's active leaf already moved** — only a fork that
   fails before the announcement leaves no row. The earlier wording here ("a
   failed fork leaves no orphan row") was unconditional and wrong.
5. **New REST endpoints** (`server/modules/providers/provider.routes.ts`):
   - `GET /sessions/:sessionId/branches` →
     `[{ sessionId, forkedAtMessageUuid, createdAt, activeLeaf }]` for the
     cluster; branches whose `jsonl_path` no longer exists are filtered out.
   - `POST /sessions/:sessionId/activate-branch` → flips `active_leaf`
     (two-row transaction), returns the activated session.
6. Message reading is untouched: every branch is read through the existing
   `GET /sessions/:sessionId/messages`.

## 5. Frontend flow

1. **✏️ button** on user message bubbles (`src/components/chat/view/`):
   rendered only when the session's provider is `claude` and the message `id`
   is a real transcript uuid (hidden for not-yet-synced realtime messages).
   Disabled while the session is streaming (tooltip: stop the session first).
2. **Composer edit mode:** extends the existing edit-queued-draft mechanism
   (`ChatComposer.tsx`). Entering edit mode fills the composer with the old
   prompt and shows a small note (reuse `Alert` from
   `src/shared/view/ui/`): *"New branch only rewinds the conversation — code
   changes after this point are kept (see the Git tab)."* Edit state
   (`editingMessage: { uuid, originalContent } | null`) lives in
   `useChatSessionState.ts`.
3. **Send:** submit sends `options.editAtMessageUuid` over the existing
   WebSocket path. Optimistic UI: hide messages after the fork point by
   reusing the existing `viewHiddenCount` mechanism
   (`useChatSessionState.ts:304`), append the new prompt, stream as usual.
4. **Silent session switch:** when the server announces the new session ID,
   the store switches the active session to the new branch without changing
   the view. Any **new** WebSocket event kind added for this feature MUST get
   an explicit `case` in `useChatRealtimeHandlers.ts` (unhandled kinds corrupt
   the message store — known gotcha).
5. **`BranchSwitcher` component:** on session load, fetch
   `GET /sessions/:id/branches`; render `‹ 1/2 ›` in the control row of the
   first plain user prompt that FOLLOWS a branch's `forkedAtMessageUuid` —
   not on the message the anchor names. The anchor is an assistant uuid (§3),
   the resume point every sibling copies verbatim, so it is the one message a
   fork does not change; the prompt after it is what actually differs between
   siblings. When no prompt follows (anchor is the last loaded message, the
   tail is optimistically hidden, or an earlier anchor already claimed that
   prompt) the control falls back to the anchor's own last non-tool assistant
   part. Rule and measurements: `pickBranchSwitcherOwners` in
   `src/components/chat/utils/branchAnchors.ts`. Arrow click →
   `POST activate-branch` → load that branch's messages into the store →
   in-place view swap. ~~Branch lists cached per cluster in
   `useSessionStore`~~ — **not shipped:** the list is component state in
   `ChatInterface.tsx`, refetched for whichever session is in view.
6. **Sidebar:** shows only active-leaf rows (server provides the field).
   ~~the cluster row gets a small branch icon + branch count~~ — **not
   shipped.** The badge and the sidebar branch list were both built during
   review and then removed: two surfaces counting branches two different ways
   (siblings at this anchor vs. whole-cluster size) contradicted each other on
   screen. The server-side `branchCount` that fed them has been removed too.

## 6. Error handling & edge cases

| Case | Behavior |
|---|---|
| Fork fails (SDK error, dead CLI, unknown uuid) | Restore `viewHiddenCount = 0` (old view reappears intact), put the edited text back in the composer and re-enter edit mode, show a destructive `Alert` above the input (as shipped — not a toast). No DB row exists if the failure preceded the SDK's session-id announcement; see §4.4 for the case where it did not. |
| Edit the FIRST prompt | Not supported: ✏️ hidden on the first user message (pagination-aware — only once the full history is loaded); server rejects with `FORK_FAILED` ("start a new session instead") for stale/non-UI clients. |
| ✏️ while streaming | Button disabled; user aborts first (existing control). |
| Edit on a non-active branch | Works identically — fork from the viewed session; new branch becomes active leaf. |
| Root transcript deleted / cleaned up (30-day retention) | Resume fails → generic fork-failure path with explicit message; `GET /branches` filters branches with missing `jsonl_path`. |
| Two tabs on one cluster | Active-leaf changes propagate through the existing session-updates broadcast; no locking. Worst case two sibling branches → switcher shows `< 1/3 >`. |
| Pending tool approvals at fork time | Not inherited by the new session (same as CLI `/branch` — permission grants don't copy). No extra code; documented behavior. |
| Migration | New columns nullable/default → zero behavior change for existing sessions; no rollback needed. |

## 7. Testing

Per repo reality (no `npm test`; server tests run via
`npx tsx --test --tsconfig server/tsconfig.json`):

0. **Pre-implementation spike (plan step 0):** script against the real SDK —
   3-turn session → fork with `resumeSessionAt` = user-message uuid vs
   assistant-message uuid → inspect the branch JSONL. Locks down the
   "up to and including" boundary and the first-prompt case. Results are
   recorded in this spec before the resume-point logic is written.

   Spike result (2026-07-23): `RESUME_POINT_RULE = 'preceding-assistant-uuid'`
   — `resumeSessionAt` must be the uuid of the assistant message preceding
   the edited prompt; a user-message uuid works (no error, not ignored) but
   is taken literally as "up to and including" that user turn, so the
   original (pre-edit) user message remains in the forked transcript with
   the new prompt appended immediately after it — not the desired
   replacement semantics. Script: `scripts/spike-resume-session-at.mjs`.
1. **Server unit tests (`tsx --test`):**
   - Sessions repository: one-active-leaf-per-cluster invariant;
     activate-branch transactionality; non-forked sessions unaffected.
   - Resume-point lookup: fixed JSONL fixture → finds the message immediately
     preceding uuid X; first-prompt case; unknown uuid → clear error.
   - `mapCliOptionsToSDK`: `editAtMessageUuid` → `resumeSessionAt` +
     `forkSession: true`; absent → nothing set (regression guard).
   - Branches endpoint: 3-branch cluster listing + dead-`jsonl_path`
     filtering.
2. **E2E (Playwright, manual against dev server :5173):** send 2 prompts →
   edit prompt 1 → send → assert in-place branch swap + `< 1/2 >` appears →
   click `<` → assert old conversation restored. Also: Cursor session shows
   no ✏️ button. Pre-PR smoke test; not wired into CI.
3. **Manual checks:** two-tab active-leaf sync; edit when the root transcript
   was deleted.

## 8. Out of scope

- Code/file revert (`enableFileCheckpointing` / `rewindFiles`) — use the Git
  panel.
- "Regenerate" on assistant replies.
- Providers other than Claude.
- Cross-tool fork discovery (forks made by the CLI outside cloudcli).
- Message-level tree storage / `parentUuid` parsing.
