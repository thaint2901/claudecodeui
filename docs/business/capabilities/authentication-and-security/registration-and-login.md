# Capability: Registration & Login

## Description

Lets the first user register an admin account on a fresh install; subsequent users log in with username + password. Passwords are bcrypt-hashed; sessions are JWT-based. Logout discards the token client-side.

## Actors

- **End user** — Registers the first account; logs in.
- **The auth service** — Validates credentials and issues tokens.
- **`users` table** — Stores the account.
- **bcrypt** — Hashes the password.

## Trigger

- The user opens the app on a fresh install (no `users` row).
- The user logs out and tries to access a protected route.

## Flow (First-Run Registration)

1. The app boots; `needsSetup` is `true`.
2. The frontend shows the **Setup** form (`SetupForm.tsx`).
3. The user enters a username and password and submits.
4. `POST /api/auth/register` is called.
5. The password is bcrypt-hashed and a `users` row is created.
6. A 7-day JWT is issued and returned.
7. The user is logged in; `needsSetup` becomes `false`.

## Flow (Login)

1. The user opens the app; `needsSetup` is `false`.
2. The frontend shows the **Login** form (`LoginForm.tsx`).
3. The user enters credentials and submits.
4. `POST /api/auth/login` is called.
5. The password is verified against the bcrypt hash.
6. `last_login` is updated.
7. A 7-day JWT is issued and returned.
8. The user is logged in.

## Flow (Logout)

1. The user clicks **Logout**.
2. The frontend discards the JWT.
3. The next request returns 401; the user is redirected to login.

## Output

- A registered user account.
- A 7-day JWT.
- (On login) Updated `last_login`.
- (On logout) A clean redirect to login.

## Technical Mapping

- **Backend route:** `server/routes/auth.js`
- **Backend middleware:** `server/middleware/auth.js` (`authenticateToken`)
- **Backend repo:** `server/modules/database/repositories/users.ts`
- **Frontend login:** `src/components/auth/view/LoginForm.tsx`
- **Frontend setup:** `src/components/auth/view/SetupForm.tsx`
- **Frontend context:** `src/contexts/AuthContext.tsx`
- **Frontend gate:** `src/components/auth/view/ProtectedRoute.tsx`

## Dependencies

- **Database Layer** — `users` table.
- **Authentication & Security** — JWT lifecycle.
