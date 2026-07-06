# Self-Hosted Deployment: Shared Linux Server (User-Level)

Deployment guide for running the published `@cloudcli-ai/cloudcli` npm package as a **personal, single-user** instance on a **shared multi-user Linux server**, reachable from anywhere (including mobile) through a Cloudflare Tunnel.

Everything runs at **user level** inside `$HOME` (nvm + PM2 + cloudflared). `sudo` is used exactly once, to register PM2's boot unit.

> This recipe was adversarially reviewed against the server source (`server/middleware/auth.js`, `server/index.js`, `server/load-env.js`) and verified empirically (PM2 7.x flag tests, cloudflared 2026.x). Several "obvious" variants of these steps are broken — see [Pitfalls](#pitfalls-do-not-improvise) before changing anything.

## Architecture

```
Phone / any browser → Cloudflare proxy (+ login rate-limit rule) → Tunnel → 127.0.0.1:<PORT> → CloudCLI
                                                                              layer 1: strong admin password
                                                                              layer 2: agent tools disabled by default
```

Decisions baked into this plan:

| Decision | Rationale |
|---|---|
| No Cloudflare Access / no `API_KEY` | Single user, strong random password; a Cloudflare WAF rate-limit rule replaces Access as the anti-bruteforce layer. Note: enabling `API_KEY` naively **bricks the web UI** — the frontend never sends the `x-api-key` header that `server/index.js` requires on all of `/api` when the variable is set. |
| Bind `127.0.0.1`, random high port | cloudflared talks to loopback on the same box. On a shared server, loopback is still machine-wide — other local users can reach the port — so the admin password is the real barrier on that side. |
| cloudflared as a user process under PM2, token in a file | `sudo cloudflared service install <TOKEN>` writes the token into a world-readable (644) root unit file — every local user could read it. A `chmod 600` token file in `$HOME` avoids that, and PM2 supervises both processes with one autostart. |
| No `JWT_SECRET` env var | Optional: the server auto-generates a per-install secret and persists it in `auth.db` (`server/middleware/auth.js`). |
| No `DATABASE_PATH` env var | The default is already `$HOME/.cloudcli/auth.db` (`server/load-env.js`). Setting it to a `~/...` value breaks — nothing expands the tilde. |
| Pinned version, never `@latest` | A daemon must not mutate silently. Update deliberately (see [Operations](#operations)). |

## Prerequisites

- Linux shared server, outbound internet (the tunnel is outbound-only; no inbound ports needed).
- Node **22+** available at user level (24.x verified). Check `which node`: if it points into `$HOME` (e.g. `~/.nvm/...`), use it as-is; if it is the system Node (`/usr/bin/node`), install your own via nvm so `npm i -g` stays inside `$HOME`.
- A Cloudflare account with a zone, and a Tunnel created in Zero Trust → Networks → Tunnels (copy the token).

## Steps

```bash
# ── 0. User-level Node (skip if `which node` already resolves inside $HOME)
nvm install 22        # or 24

# ── 1. App + PM2, pinned
npm i -g @cloudcli-ai/cloudcli@1.36.0 pm2
# Watch the output: better-sqlite3 / node-pty should use prebuilt binaries.
# If they fall back to node-gyp, the box needs build-essential + python3.

# ── 2. Env file — exactly these two lines
mkdir -p ~/.cloudcli && chmod 700 ~/.cloudcli
cat > ~/.cloudcli.env <<EOF
HOST=127.0.0.1
SERVER_PORT=48213
EOF
chmod 600 ~/.cloudcli.env
# Pick your own random high port. Do NOT add DATABASE_PATH (tilde is never
# expanded; the default is already $HOME/.cloudcli/auth.db) or API_KEY (bricks the UI).

# ── 3. Start the app
PKG_DIR="$(npm root -g)/@cloudcli-ai/cloudcli"
pm2 start "$PKG_DIR/dist-server/server/index.js" --name cloudcli \
  --node-args="--env-file=$HOME/.cloudcli.env"

# ── 4. VERIFY the binding — mandatory
ss -tlnp | grep 48213          # MUST show 127.0.0.1:48213, never 0.0.0.0
# (HOST falls back to 0.0.0.0 if env delivery failed — this check catches it.)

# ── 5. REGISTER THE ADMIN ACCOUNT NOW — before the tunnel exists
#   The register endpoint stays open until the first user is created; on a
#   shared box (and later, the open internet) that window must be zero.
#   From your laptop:   ssh -L 48213:127.0.0.1:48213 user@server
#   Open http://localhost:48213 and register with a 20+ char random password.

# ── 6. cloudflared, user level
mkdir -p ~/bin
curl -L -o ~/bin/cloudflared \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
chmod +x ~/bin/cloudflared
printf '%s' '<TUNNEL_TOKEN>' > ~/.cloudflared-token && chmod 600 ~/.cloudflared-token
pm2 start ~/bin/cloudflared --name tunnel --interpreter none \
  -- tunnel run --token-file ~/.cloudflared-token

# ── 7. Autostart — the single sudo of this recipe; covers both PM2 apps
pm2 startup                    # run the sudo command it prints
pm2 save

# ── 8. Cloudflare dashboard
#   Tunnel → Public Hostname:  cloudcli.<your-domain> → http://127.0.0.1:48213

# ── 9. Rate-limit the login endpoint (free plan includes 1 rule)
#   Security → WAF → Rate limiting rules → Create:
#     If URI Path equals /api/auth/login
#     Rate > 5 requests / 1 minute per IP  →  Block for 10 minutes

# ── 10. Smoke test from a phone: log in, open one chat and one terminal.
#   If WebSocket fails through the tunnel, add --protocol http2 to the
#   `tunnel run` command in step 6 (QUIC occasionally drops the Upgrade header).
```

## Pass/fail checklist

| Step | Pass condition |
|---|---|
| 4 | `ss` shows `127.0.0.1:<PORT>` |
| 5 | Admin registered + login works via SSH forward, **before** any public hostname exists |
| 7 | After a server reboot, `pm2 ls` shows both `cloudcli` and `tunnel` online |
| 9 | Six consecutive bad logins → the sixth is blocked by Cloudflare |
| 10 | Chat streams and the terminal works from a phone over the public hostname |

## Operations

- **Back up `~/.cloudcli/auth.db` weekly.** It holds the account, API keys, and the auto-generated JWT secret. Losing it means re-registering from scratch.
- **Logs:** `pm2 install pm2-logrotate` — PM2 does not rotate logs by itself.
- **Upgrading the app:** `npm i -g @cloudcli-ai/cloudcli@<new>` then `pm2 restart cloudcli`. The UI may show a "server was updated but not restarted" toast until the restart completes.
- **Switching Node versions (nvm):** the global package dir moves with the Node version, so the absolute path PM2 saved goes stale. `pm2 delete cloudcli`, re-resolve `PKG_DIR`, start again, `pm2 save`.
- **Keep agent tools disabled by default** (the shipped default). If the password is ever compromised, disabled tools mean the intruder cannot run shell commands or edit files through the agent.
- **Don't count on an obscure hostname:** Cloudflare's certificates appear in public CT logs; bots find new hostnames within hours. The rate-limit rule and the password are the real defenses.
- **Never place a `.env` inside the npm package directory** — `npm update -g` wipes it. Env delivery belongs to the PM2 start line (step 3).

## Pitfalls (do not improvise)

These variants look reasonable and are all broken — each was verified to fail:

| Tempting variant | Why it fails |
|---|---|
| `pm2 start cloudcli --name cloudcli` (bin name) | PM2 does not reliably resolve globally-installed bin scripts. Start the entry file directly. |
| `pm2 start ... --env-file ~/.cloudcli.env` | **PM2 has no `--env-file` flag** (through 7.x); the process never starts. The flag in step 3 is Node's own (`--node-args`), which requires Node ≥ 20.6. |
| `PKG_DIR=$(dirname $(dirname $(readlink -f $(which cloudcli))))` | Off by one directory (`cli.js` is two levels deep inside the package) → ENOENT. Use `npm root -g`. |
| `DATABASE_PATH=~/.cloudcli/auth.db` in the env file | Neither Node's `--env-file` nor the server expands `~` → a literal `./~` directory. Omit the variable. |
| Setting `API_KEY` "as a second factor" | Gates every `/api/*` route on an `x-api-key` header the web frontend never sends — including login. The UI dies everywhere. |
| `sudo cloudflared service install <TOKEN>` | Works, but the token lands in a 644 root-owned unit file readable by every local user, and it does not prompt — the token must be inline. Prefer the user-level token file. |
| `pm2 start ~/bin/cloudflared` without `--interpreter none` | PM2 may try to load the Go binary as a Node script. |
| Cluster mode (`pm2 start -i`) | The server is a stateful single process (PTY sessions, WebSocket hub); fork mode only. |

## Known limits

- JWT lifetime is hardcoded to 7 days (auto-refresh at half-life); no env knob.
- The OSS build is single-account — no per-user isolation. Anyone with the password acts as you, with your `~/.claude` credentials on that box.
- Other local users on the shared server can reach `127.0.0.1:<PORT>` directly (loopback is machine-wide); the password is the only barrier on that path. If that ever becomes unacceptable, the documented hardening is `API_KEY` **plus** a Cloudflare Request-Header Transform Rule injecting `x-api-key` at the edge.
