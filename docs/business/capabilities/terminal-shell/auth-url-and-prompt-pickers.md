# Capability: Auth URL & Prompt Pickers

## Description

Detects `http(s)://` URLs and interactive CLI prompts (Claude login, Gemini, etc.) in the terminal buffer and surfaces one-click affordances: **Open in browser**, **Copy URL**, and **Pick option**. Eliminates the need to manually copy URLs or type answers into a CLI prompt the agent is waiting on.

## Actors

- **End-user developer** — Clicks the affordance.
- **`url-detection.js`** — Scans the buffer for URLs and known prompt patterns.
- **The shell WebSocket service** — Receives URL / picker events from the frontend.
- **The browser** — Opens the auth URL.

## Trigger

- A new chunk of terminal output is written to the buffer.
- A URL is detected (matches a known auth URL pattern or any http(s) URL).
- A prompt picker pattern is matched (e.g. Claude's `[1] Yes [2] No`).

## Flow (Auth URL)

1. The shell service writes a chunk to xterm.js.
2. `url-detection.js` runs on the new chunk and detects an `http(s)://` URL.
3. The frontend displays an **Open** button next to the URL.
4. The user clicks **Open**; the system browser opens the URL.
5. (Alternatively) the user clicks **Copy** to copy the URL to the clipboard.

## Flow (Prompt Picker)

1. The shell service writes a chunk containing a known prompt pattern.
2. `url-detection.js` matches the pattern and extracts the options.
3. The frontend renders the options as clickable buttons.
4. The user clicks an option; the shell service writes the corresponding keystroke to the PTY.

## Output

- A clickable affordance next to the URL or prompt in the terminal.
- The system browser opens the URL (auth flow).
- The PTY receives the picked option as a keystroke (prompt answer).

## Technical Mapping

- **Frontend header:** `src/components/shell/view/subcomponents/ShellHeader.tsx` (renders affordances)
- **Backend detector:** `server/utils/url-detection.js`
- **Backend colors:** `server/utils/colors.js` (ANSI stripping for clean detection)
- **Backend service:** `server/modules/websocket/services/shell-websocket.service.ts`

## Dependencies

- **Terminal/Shell** — The PTY stream and the buffer.
- **Provider Integration** — Each provider's login flow has its own URL/prompt pattern.
