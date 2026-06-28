# Capability: Light & Dark Themes

## Description

Light and dark theme support with localStorage persistence and OS-preference fallback. The theme is applied to the DOM via CSS classes and synced to the iOS status-bar meta and theme-color meta tags.

## Actors

- **End user** — Picks a theme in Settings.
- **`ThemeContext`** — The theme state and side effects.
- **The OS** — Provides the `prefers-color-scheme` media query.

## Trigger

- The app boots.
- The user changes the theme in Settings.
- The OS color scheme changes (when "System" is selected).

## Flow (Boot)

1. The app boots; `ThemeContext` reads the stored theme from localStorage.
2. If "System", the OS `prefers-color-scheme` is checked.
3. The theme is applied to the DOM.
4. The iOS / theme-color meta tags are updated.

## Flow (Switch)

1. The user opens Settings → Appearance and picks Light / Dark / System.
2. `ThemeContext` updates the DOM and meta tags.
3. The choice is persisted to localStorage.

## Output

- A consistent, theme-aware UI.
- A persisted theme choice.
- OS-preference integration.

## Technical Mapping

- **Context:** `src/contexts/ThemeContext.jsx`
- **Settings UI:** `src/components/settings/view/tabs/AppearanceSettingsTab.tsx`
- **Quick settings panel:** `src/components/quick-settings-panel/view/QuickSettingsContent.tsx`

## Dependencies

- **Internationalization & Theming** — All other capabilities.
- **Distribution** — PWA meta integration.
