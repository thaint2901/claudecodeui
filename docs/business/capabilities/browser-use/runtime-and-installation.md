# Capability: Runtime & Installation

## Description

Detects whether Playwright + Chromium are installed and ready, and (on demand) installs them. Probes are cached for 30s; the install path has a 10-minute timeout.

## Actors

- **End user** — Toggles browser tools on in Settings.
- **The browser-use service** — Probes and installs the runtime.
- **Playwright + Chromium** — The browser automation runtime.

## Trigger

- The user opens Settings → Browser-Use.
- The service is asked to probe or install.

## Flow (Probe)

1. The service calls `playwright.chromium.executablePath()`.
2. The result is cached for 30s.
3. The probe result is reported to the UI as "ready" or "not installed".

## Flow (Install)

1. The user clicks **Install** in Settings → Browser-Use.
2. The service runs `npm install --no-save playwright`.
3. On Linux, the service runs `playwright install-deps chromium`.
4. The service runs `playwright install chromium`.
5. The install has a 10-minute timeout.
6. On success, the probe returns "ready".

## Output

- A ready Playwright + Chromium runtime.
- A "ready" status in the UI.
- (On failure) An error message in the UI.

## Technical Mapping

- **Backend service:** `server/modules/browser-use/browser-use.service.ts`
- **Settings persistence:** `appConfigDb` (key `browser_use_settings`)
- **Settings UI:** `src/components/settings/view/tabs/browser-use-settings/BrowserUseSettingsTab.tsx`

## Dependencies

- **Browser-Use** — All other capabilities.
- **Database Layer** — `app_config` for the settings toggle.
