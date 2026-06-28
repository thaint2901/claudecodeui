# Capability: PWA (Progressive Web App)

## Description

Installable web app — the Vite build emits `dist/` which is served by the Express server. The page registers `/sw.js`, links `/manifest.json`, includes iOS `apple-mobile-web-app-capable` meta and apple-touch-icons, and ships maskable icons at 72–512px. The same bundle powers the web UI, Docker sandbox, and Electron shell.

## Actors

- **Mobile / tablet users** — Add to Home Screen on iOS / Android.
- **Desktop users** — Install via the browser's install prompt.
- **The service worker** — Caches the manifest and serves the app shell.

## Trigger

- The user opens the app in a supported browser.
- The user clicks "Add to Home Screen" (iOS) or "Install" (Chrome / Edge).

## Flow

1. The user opens the app; the browser fetches the HTML.
2. The HTML registers `/sw.js` on `window.load`.
3. The service worker precaches `/manifest.json`.
4. HTML navigations are network-first with a tiny "Offline" fallback.
5. Hashed `/assets/*` are cache-first.
6. `/api` and `/ws` are never intercepted.
7. The user installs the app; the browser shows the install prompt.
8. The installed app runs in standalone mode with the configured theme.

## Output

- An installable web app.
- A consistent theme and icon set.
- Web-push notifications (via the service worker).

## Technical Mapping

- **Manifest:** `public/manifest.json`
- **Service worker:** `public/sw.js`
- **HTML meta:** `index.html` (apple-mobile-web-app-capable, status-bar-style, title, apple-touch-icons)
- **Icons:** `public/icons/` (8 maskable, 72–512px)
- **Registration:** `src/main.jsx` (`'serviceWorker' in navigator` feature check)
- **Web-push:** `server/services/notification-orchestrator.js` + `public/sw.js`

## Dependencies

- **Distribution** — npm package (the same bundle).
- **Notification System** — Web-push delivery.
- **Internationalization & Theming** — Theme meta integration.
