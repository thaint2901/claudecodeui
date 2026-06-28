# Capability: Settings UI Integration

## Description

Surfaces the language and theme controls in Settings → Appearance, plus per-session overrides in the Quick Settings Panel. The settings UI is the user-facing entry point for the translation system and the theme system.

## Actors

- **End user** — Picks a language or theme.
- **The Appearance Settings tab** — The main entry point.
- **The Quick Settings Panel** — Per-session overrides.

## Trigger

- The user opens Settings → Appearance.
- The user opens the Quick Settings Panel.

## Flow

1. The user opens Settings → Appearance.
2. The user toggles theme (Light / Dark / System) and language.
3. The settings are persisted to localStorage and applied via `ThemeContext` / `i18next.changeLanguage`.
4. The user can also drag the Quick Settings Panel to a per-session override position.

## Output

- A consistent settings surface.
- Per-session overrides via the Quick Settings Panel.

## Technical Mapping

- **Settings tab:** `src/components/settings/view/tabs/AppearanceSettingsTab.tsx`
- **Quick settings panel:** `src/components/quick-settings-panel/view/QuickSettingsContent.tsx`
- **Drag hook:** `src/components/quick-settings-panel/hooks/useQuickSettingsDrag.ts`

## Dependencies

- **Internationalization & Theming** — All other capabilities.
