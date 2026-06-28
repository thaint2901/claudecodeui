# Capability: Tool Permission Model

## Description

Gates dangerous agent tool calls (file writes, bash, network requests) behind an explicit user approval flow. The user can approve or deny each call, optionally remember the choice, or switch the session into a less restrictive permission mode (plan, accept-edits, bypass-permissions).

## Actors

- **End-user developer** — Approves or denies tool calls.
- **The provider runtime** — Requests approval.
- **The `PermissionContext`** — Holds pending requests.
- **The `PermissionRequestsBanner`** — Surfaces requests in the UI.

## Trigger

- The provider runtime wants to invoke a tool that requires approval.

## Flow (Per-Call Approval)

1. The runtime calls the approval hook with the tool name, input, and permission mode.
2. The chat run registry holds the run in a waiting state and emits a `permission_request` event.
3. The frontend receives the event; `PermissionContext` adds it to pending.
4. `PermissionRequestsBanner` surfaces the request inline.
5. The user picks **Allow**, **Deny**, or **Allow and remember**.
6. The frontend sends a `chat.permission-response` envelope.
7. The runtime proceeds (allow) or aborts (deny).
8. If "remember" was chosen, the rule is persisted and applied to future calls.

## Flow (Permission Modes)

- **default** — Ask on every dangerous call.
- **accept-edits** — Auto-allow file edits; ask on bash / network.
- **plan** — Read-only; ask on anything beyond reads.
- **bypass-permissions** — Auto-allow everything (use with care).

## Output

- A decision recorded for the tool call.
- An optional "remember this" rule persisted across sessions.
- A session-level permission mode change (if the user changed it).

## Technical Mapping

- **Frontend context:** `src/contexts/PermissionContext.tsx`
- **Frontend UI:** `src/components/chat/view/subcomponents/PermissionRequestsBanner.tsx`
- **Backend hook:** `server/claude-sdk.js` (`canUseTool`)
- **Protocol:** `chat.permission-response` envelope via `chat-websocket.service.ts`
- **Settings:** `src/components/settings/view/tabs/agents-settings/`

## Dependencies

- **Chat & Agent Streaming** — The event stream.
- **Provider Integration** — Per-provider permission-mode mapping.
- **Authentication & Security** — User identity behind the decision.
