# ADR-0001: Extension-point strategy for fork customizations

**Date:** 2026-07-31
**Status:** accepted
**Deciders:** thaint2901 + Claude architecture-review session

## Context

This repo is a long-lived fork of `siteboon/claudecodeui`, and the customization surface has grown large enough that maintaining it by ad-hoc inline patching is measurably expensive:

- The fork is **159 commits ahead** of upstream, with merge-base `27eaf01`.
- **73 files** have been touched by both the fork and upstream since the merge-base.
- The hottest file on both sides' change lists is `src/components/chat/view/ChatInterface.tsx`: **24 fork edits vs. 9 upstream edits** in upstream's last 60 commits.
- A past upstream merge cost **~30 add/add conflicts**, concentrated in i18n JSON files.
- Planned future customizations follow the same shape and will keep landing in the same overlap zone: in-flight branches for the Hermes provider, computer-use, and the command palette.

Left unaddressed, each new fork feature and each upstream sync compounds the conflict surface instead of shrinking it.

## Decision

Adopt an extension-point strategy with four concrete rules:

1. **Additive structure.** New features are added as new `server/modules/*` folders and new `src/components/*` feature folders, rather than being woven into existing upstream files.
2. **Fork-owned files.** Behavior changes to upstream code are extracted into fork-owned hooks/services, leaving upstream files with call sites of at most 2 lines.
3. **Fork i18n namespace.** Fork-specific translation keys live in a `fork.json` namespace per locale, never appended to upstream's `chat.json`/`settings.json`.
4. **Provider execution behind `IProvider`/registry.** Provider execution moves behind an `IProvider` interface and registry, so adding a new provider is one new folder plus one registry line.

## Alternatives Considered

**(a) Status quo — inline patching.**
Pros: no new machinery, no discipline to learn.
Cons: this is the status quo that produced the numbers above — 73 overlap files, a 24-vs-9 hotspot, and a 30-conflict i18n merge.
Rejected: the measured conflict cost already documented in Context makes this untenable going forward.

**(b) Full plugin/patch layer isolating all fork code from upstream.**
Pros: maximal isolation, near-zero merge conflicts by construction.
Cons: heavyweight indirection (a patch/plugin runtime) for a fork that syncs from upstream only occasionally — upstream cadence is ~3 commits since the merge-base.
Rejected: the machinery cost outweighs the benefit at this sync cadence.

**(c) Hard fork — stop syncing with upstream entirely.**
Pros: eliminates merge conflicts entirely; no ongoing sync tax.
Cons: forfeits upstream fixes and features the fork has demonstrably absorbed (e.g. the v1.36.x adoptions).
Rejected: the fork's history shows real value from continuing to absorb upstream changes.

## Consequences

**Positive:** the upstream conflict surface shrinks measurably as fork logic moves out of upstream-owned files and into fork-owned extension points.

**Negative:** the strategy introduces indirection — call sites plus separate fork-owned files — and requires ongoing registration discipline (new modules, new registry entries) rather than "just editing the file that's already open."

**Neutral:** the scorecard below is the acceptance gate for the refactor phases that implement this ADR.

| Metric | Baseline | Target |
|---|---|---|
| Upstream-overlap files | 73 | <30 |
| Provider registration points | 4 | 1 |
| Backend dependency cycles | 5 | 0 |
| Legacy deep-imports bypassing barrels | 24 | 0 |
| `MessageKind` definitions | 2 | 1 |
| `useChatComposerState` Code Health | 4.15 | ≥7 |
| Legacy-tier line coverage (refactor-touched paths) | 0% | ≥50% |
