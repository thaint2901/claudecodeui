# Capability: Docker Sandbox

## Description

Prebuilt Docker images that bundle CloudCLI UI on top of Claude Code, Codex, and Gemini CLI inside a microVM. Each image installs the npm package globally and auto-starts the web UI on shell open via `.bashrc`. Published to `docker.io/cloudcliai/sandbox:*`.

## Actors

- **Sandbox users** — Run a microVM with the agent of their choice.
- **The `sbx` CLI** — Wraps the Docker Sandbox workflow.

## Trigger

- A user runs the `sbx` workflow (or pulls a `cloudcliai/sandbox:*` image directly).

## Flow

1. The user runs `sbx ...` (or pulls and runs the image).
2. The image is `FROM docker/sandbox-templates:<agent>`.
3. `docker/shared/install-cloudcli.sh` installs build tools and runs `npm install -g @cloudcli-ai/cloudcli`.
4. `cloudcli --version` is run to verify.
5. `docker/shared/start-cloudcli.sh` is dropped into `/home/agent/.cloudcli-start.sh` and sourced from `.bashrc`.
6. On shell open, the server auto-starts on port 3001.

## Output

- A microVM with the agent and the UI pre-installed.
- The UI auto-starts on shell open.
- Default env: `SERVER_PORT=3001`, `HOST=0.0.0.0`, `DATABASE_PATH=~/.cloudcli/auth.db`.

## Technical Mapping

- **Templates:** `docker/claude-code/Dockerfile`, `docker/codex/Dockerfile`, `docker/gemini/Dockerfile`
- **Shared scripts:** `docker/shared/install-cloudcli.sh`, `docker/shared/start-cloudcli.sh`
- **README:** `docker/README.md`

## Dependencies

- **Distribution** — npm package.
- **Database Layer** — `~/.cloudcli/auth.db` persistence.
