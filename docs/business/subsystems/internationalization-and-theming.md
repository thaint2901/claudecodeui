# Subsystem 12: Internationalization & Theming

## Business Purpose

The **Internationalization & Theming** subsystem makes CloudCLI UI accessible to a global audience. It ships with **ten language translations** and a **light/dark theme** system with localStorage persistence and OS-preference fallback. Together they let every user read the app in their own language and pick the visual style that fits their environment.

This is the "polish" subsystem — the features that make a product feel native to the user, not just functional.

## Supported Languages

| Code | Language |
|------|----------|
| `en` | English (default) |
| `fr` | French |
| `ko` | 한국어 (Korean) |
| `zh-CN` | 简体中文 (Simplified Chinese) |
| `zh-TW` | 繁體中文 (Traditional Chinese) |
| `ja` | 日本語 (Japanese) |
| `ru` | Русский (Russian) |
| `de` | Deutsch (German) |
| `tr` | Türkçe (Turkish) |
| `it` | Italiano (Italian) |

The supported languages mirror the `README.*.md` translations in the repo root.

## Key Capabilities

| Capability | Description |
|------------|-------------|
| **i18next setup** | `src/i18n/config.js` wires i18next + react-i18next |
| **Language switcher** | User picks from the ten supported languages |
| **localStorage persistence** | Language choice persists across sessions |
| **Translation files** | One JSON file per language under `src/i18n/locales/` |
| **Light / dark theme** | `ThemeContext` (light, dark, system) |
| **OS preference fallback** | When "system" is selected, follows the OS color scheme |
| **Meta tag sync** | iOS status-bar meta and theme-color meta are updated when the theme changes |
| **Code editor theming** | CodeMirror themes for light and dark |
| **Markdown theme** | Markdown render picks up the current theme |
| **Settings UI** | Appearance settings tab; theme + language controls |

## Stakeholders

| Stakeholder | What They Get |
|-------------|---------------|
| **Global users** | The app in their own language. |
| **Low-light / dark-mode users** | A dark theme that respects the OS preference. |
| **Power users** | Per-session theme override in the quick settings panel. |
| **Contributors** | A simple JSON-based translation workflow. |

## How Theme Switching Works

1. The user opens Settings → Appearance.
2. They pick Light, Dark, or System.
3. `ThemeContext` (`src/contexts/ThemeContext.jsx`) updates the DOM (`document.documentElement.classList`) and the iOS / theme-color meta tags.
4. The choice is persisted to `localStorage` and reapplied on next boot.
5. If "System" is selected, the OS `prefers-color-scheme` media query drives the choice.

## How Language Switching Works

1. The user opens Settings → Appearance and picks a language.
2. `i18next.changeLanguage(lng)` swaps the active translation namespace.
3. The choice is persisted to `localStorage`.
4. On next boot, `src/i18n/config.js` reads the stored language and sets it before render.

## Cross-Cutting Concerns

- **Settings persistence** — localStorage; not synced across devices.
- **PWA integration** — Theme meta tags are read by the PWA shell to style the splash and status bar.
- **i18n keys** — Keys are stable; new translations fall back to English when missing.
- **CodeMirror** — Per-theme stylesheets are pre-bundled.
- **Markdown** — The markdown renderer uses CSS variables that flip with the theme.

## Technical Mapping (Entry Points)

- **i18n config:** `src/i18n/config.js`
- **Locale files:** `src/i18n/locales/<lang>.json` (one per language)
- **Theme context:** `src/contexts/ThemeContext.jsx`
- **Theme hook:** `useTheme` (consumer in Settings, quick settings panel, version modal, etc.)
- **Settings UI:** `src/components/settings/view/tabs/AppearanceSettingsTab.tsx`
- **Quick settings panel:** `src/components/quick-settings-panel/view/QuickSettingsContent.tsx`
- **README translations:** `README.<lang>.md`

## Capability Documents

- [capabilities/internationalization-and-theming/translation-system.md](capabilities/internationalization-and-theming/translation-system.md)
- [capabilities/internationalization-and-theming/light-and-dark-themes.md](capabilities/internationalization-and-theming/light-and-dark-themes.md)
- [capabilities/internationalization-and-theming/pwa-meta-integration.md](capabilities/internationalization-and-theming/pwa-meta-integration.md)
- [capabilities/internationalization-and-theming/settings-ui-integration.md](capabilities/internationalization-and-theming/settings-ui-integration.md)
