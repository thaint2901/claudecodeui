# ADR-0002: Independent development — the upstream-merge requirement is dropped

**Date:** 2026-07-31
**Status:** accepted
**Deciders:** thaint2901

## Context

This repo is a long-lived fork of `siteboon/claudecodeui`. By the time of this decision the fork was **96 commits ahead** of upstream (measured in ADR-0001, merge-base `27eaf01`), and ADR-0001 documented the measured cost of staying merge-compatible: a 37-file upstream-overlap surface, a hotspot file (`ChatInterface.tsx`) touched 9 times by the fork against 32 times by upstream, and a past upstream merge that cost ~30 add/add conflicts concentrated in i18n JSON files. See ADR-0001's Context section for the full figures and the exact measurement commands — they are not re-measured or re-copied here.

ADR-0001 addressed that cost with a technical extension-point strategy (additive structure, fork-owned files, i18n namespace, provider registry) on the assumption that the fork would keep periodically merging from upstream. On 2026-07-31 the user made a strategic decision that changes that assumption:

> "phát triển độc lập, bỏ yêu cầu merge từ upstream. triển khai theo best technical decision"

(Develop independently, drop the requirement to merge from upstream. Implement per the best technical decision.)

This is a product-direction decision, not a technical one: the fork's roadmap (Hermes provider, computer-use, command palette, and the composer-hook refactor this ADR accompanies) increasingly diverges from upstream at the product level, not just the file level. Continuing to optimize for merge compatibility with a codebase the fork is intentionally diverging from no longer matches how the project is actually being built.

## Decision

`siteboon/claudecodeui` is no longer merged into this fork. Upstream becomes a **read-only reference** — at most a source to cherry-pick specific ideas or fixes from, evaluated case by case, never a branch this repo merges or rebases onto.

Future work is planned and reviewed purely against this fork's own technical and product goals, not against upstream compatibility.

## Alternatives Considered

**(a) Keep periodic upstream syncs.**
Pros: continues absorbing upstream fixes and features (e.g. the v1.36.x adoptions ADR-0001 cites); keeps the door open to community contributions flowing through upstream.
Cons: the conflict cost is already measured and real (ADR-0001's 37-file overlap, 9-vs-32 hotspot, 30-conflict i18n merge); and the fork's own roadmap is now diverging at the product level, so future syncs would fight against intentional, not incidental, divergence.
Rejected: the cost is measured and rising, and the value it buys (upstream parity) is no longer a project goal.

**(b) Re-fork later if needed.**
Noted as the escape hatch, not adopted now: the `upstream` git remote stays configured, so a future re-fork or selective cherry-pick from `siteboon/claudecodeui` remains possible without re-adding it as a merge source. This preserves optionality without carrying the ongoing sync tax.

## Consequences

**Superseded:** ADR-0001's strategic rationale — its four rules justified as merge-conflict mitigation — is superseded. There is no more upstream merge to protect against conflicts in.

**Survives on technical merit:** ADR-0001's hygiene rules do not disappear; they are retained in `CLAUDE.md`'s `## Development Model` section (renamed from `## Fork Maintenance`) purely as good structural practice — new logic in new, focused files, and app-specific i18n keys isolated in a `fork.json` namespace — independent of any upstream-compatibility argument.

**Scorecard:** ADR-0001's acceptance-gate scorecard drops its upstream-overlap-specific metrics (upstream-overlap file count, predictive conflict surface); the structural/health metrics that don't depend on upstream comparison (Code Health scores, dependency cycles, deep-import counts, `MessageKind` duplication, coverage) carry forward unchanged.

**Going forward:** future phases are planned and reviewed purely against this fork's own structural-quality and product goals — there is no upstream-compatibility gate to satisfy.
