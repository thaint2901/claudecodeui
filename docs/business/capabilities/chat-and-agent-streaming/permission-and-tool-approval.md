# Capability: Permission & Tool Approval

## Description

Gates dangerous tool calls (file writes, bash, network requests) behind an explicit user approval flow. The user can approve or deny each call, optionally remember the choice, or switch the session into a less restrictive permission mode (plan, accept-edits, bypass-permissions).

## Actors

- **End-user developer** — Approves or denies tool calls.
- **The provider runtime** — Requests approval via `canUseTool` (Claude) or equivalent.
- **The PermissionContext** — Holds pending requests and exposes a single decision handler.
- **The chat pane** — Renders the `PermissionRequestsBanner` and routes decisions back.

## Trigger

- The provider runtime wants to invoke a tool that requires approval.

## Flow

1. The runtime calls the approval hook with the tool name, input, and current permission mode.
2. The chat run registry holds the run in a waiting state and emits a `permission_request` event to the client.
3. The frontend receives the event; `PermissionContext` adds the request to its pending list.
4. `PermissionRequestsBanner` surfaces the request inline in the chat pane.
5. The user picks **Allow**, **Deny**, or **Allow and remember**.
6. The frontend sends a `chat.permission-response` envelope with the decision.
7. The runtime either proceeds (allow) or aborts the tool call (deny).
8. If "remember" was chosen, the rule is persisted and applied to future calls.

## Output

- A decision recorded for the tool call.
- An optional "remember this" rule persisted across sessions.
- The runtime proceeds or aborts the tool call.
- A session-level permission mode change (if the user changed it).

## Technical Mapping

- **Frontend context:** `src/contexts/PermissionContext.tsx`
- **Frontend UI:** `src/components/chat/view/subcomponents/PermissionRequestsBanner.tsx`
- **Frontend dispatch:** `src/components/chat/tools/configs/permissionPanelRegistry.ts`
- **Backend hook:** `server/claude-sdk.js` (`canUseTool`)
- **Protocol:** `chat.permission-response` envelope via `chat-websocket.service.ts`

## Dependencies

- **Chat & Agent Streaming** — The event stream.
- **Provider Integration** — Per-provider permission-mode mapping.
- **Authentication & Security** — The user identity behind the decision.
