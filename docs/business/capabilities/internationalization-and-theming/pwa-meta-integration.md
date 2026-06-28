# Capability: PWA Meta Integration

## Description

Syncs the iOS status-bar meta and theme-color meta tags with the current theme so the PWA splash and status bar match the user's preference. The manifest's `theme_color` is read by the browser to style the splash.

## Actors

- **`ThemeContext`** — Updates the meta tags.
- **The PWA shell** — Reads the meta tags.
- **iOS Safari** — Uses the apple-mobile-web-app meta tags.

## Trigger

- The theme changes.
- The app boots.

## Flow

1. The theme is applied.
2. `ThemeContext` updates `<meta name="theme-color">` and `<meta name="apple-mobile-web-app-status-bar-style">`.
3. The PWA shell re-renders the splash with the new color.
4. On iOS, the status bar matches the theme.

## Output

- A polished PWA experience.
- A status bar that matches the theme.

## Technical Mapping

- **Context:** `src/contexts/ThemeContext.jsx`
- **HTML meta:** `index.html` (apple-mobile-web-app-capable, status-bar-style, title, apple-touch-icons)
- **Manifest:** `public/manifest.json` (theme_color)

## Dependencies

- **Internationalization & Theming** — Light & dark themes.
- **Distribution** — PWA.
