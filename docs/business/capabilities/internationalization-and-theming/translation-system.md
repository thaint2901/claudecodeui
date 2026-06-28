# Capability: Translation System

## Description

i18next + react-i18next setup with ten language translations. The user picks a language in Settings → Appearance; the choice is persisted to localStorage and applied on the next boot. New translations fall back to English when a key is missing.

## Actors

- **End user** — Picks a language in Settings.
- **i18next** — The translation runtime.
- **react-i18next** — The React integration.
- **The locale files** — One JSON per language.

## Trigger

- The app boots.
- The user changes the language in Settings.

## Flow (Boot)

1. The app boots; `src/i18n/config.js` reads the stored language from localStorage.
2. The active translation namespace is set.
3. The UI renders in the chosen language.

## Flow (Switch)

1. The user opens Settings → Appearance and picks a language.
2. `i18next.changeLanguage(lng)` is called.
3. The active namespace is swapped.
4. The choice is persisted to localStorage.

## Output

- A consistent, translated UI.
- A persisted language choice.

## Technical Mapping

- **i18n config:** `src/i18n/config.js`
- **Locale files:** `src/i18n/locales/<lang>.json`
- **Settings UI:** `src/components/settings/view/tabs/AppearanceSettingsTab.tsx`
- **README translations:** `README.<lang>.md`

## Dependencies

- **Internationalization & Theming** — All other capabilities.
