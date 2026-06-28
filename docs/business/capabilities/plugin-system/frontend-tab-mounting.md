# Capability: Frontend Tab Mounting

## Description

Renders a plugin's UI as a tab inside the main content shell. The plugin's entry module is loaded at runtime by `PluginTabContent`; the plugin defines its own layout, hooks, and data sources.

## Actors

- **End user** — Clicks the plugin's tab.
- **`PluginsContext`** — Provides the plugin registry.
- **`PluginTabContent`** — Mounts the plugin's entry module.
- **The plugin's frontend** — The React/module the plugin ships.

## Trigger

- The user clicks the plugin's tab in the main content shell.

## Flow

1. The frontend loads the plugin registry from `/api/plugins`.
2. The main content shell renders a tab for each enabled plugin.
3. The user clicks the tab; `PluginTabContent` mounts.
4. The entry module is loaded dynamically (per the manifest's `type` — `react` or `module`).
5. The plugin renders its own UI and may make REST/WebSocket calls to its backend (or to the host).
6. The user can switch away; the plugin is unmounted.

## Output

- A native-feeling tab inside the main content shell.
- The plugin's UI rendered with full access to the host's React tree.
- A tab icon (`PluginIcon`) and label.

## Technical Mapping

- **Frontend context:** `src/contexts/PluginsContext.tsx`
- **Frontend views:** `src/components/plugins/view/PluginTabContent.tsx`, `PluginIcon.tsx`
- **Frontend mount:** entry module loaded at runtime per the manifest

## Dependencies

- **Plugin System** — Discovery & manifest.
- **Chat & Agent Streaming** — The main content shell that hosts the tabs.
