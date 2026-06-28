# Capability: Git Identity & Onboarding

## Description

Stores the user's git identity (name + email) and onboarding state. The git identity is used as the committer for any git operations the user makes from the UI. The onboarding flow guides new users through connecting their CLI agents and setting their git identity.

## Actors

- **End user** — Sets their git identity; completes the onboarding wizard.
- **`users` table** — Stores `git_name`, `git_email`, `has_completed_onboarding`.
- **`server/utils/gitConfig.js`** — Auto-populates from system git config; applies globally.
- **The onboarding wizard** — Guides the user through setup.

## Trigger

- The user opens the app for the first time after registration.
- The user saves Settings → Git identity.
- The user opens the onboarding wizard.

## Flow (Auto-Populate)

1. The user registers and is redirected to the onboarding wizard.
2. The service reads the system git config (`git config --global user.name` / `user.email`).
3. The result is pre-filled in the Git identity step.
4. The user confirms or edits.

## Flow (Save)

1. The user saves their git identity in Settings → Git.
2. The `users` row is updated.
3. The values are also applied globally with `git config --global`.

## Flow (Onboarding)

1. The user is prompted to connect at least one CLI agent.
2. Each agent step walks the user through its auth flow.
3. The git identity step is shown next.
4. On completion, `has_completed_onboarding` is set to `true`.

## Output

- A stored git identity on the user.
- An applied global git config.
- A completed-onboarding flag.

## Technical Mapping

- **Backend route:** `server/routes/user.js`
- **Backend helper:** `server/utils/gitConfig.js`
- **Backend repo:** `server/modules/database/repositories/users.ts`
- **Frontend onboarding:** `src/components/onboarding/view/Onboarding.tsx`
- **Frontend settings:** `src/components/settings/view/tabs/git-settings/GitSettingsTab.tsx`

## Dependencies

- **Authentication & Security** — User identity.
- **Database Layer** — `users` table.
- **Provider Integration** — Onboarding walks through agent auth.
