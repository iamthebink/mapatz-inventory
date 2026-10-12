---
title: 'Keep a usable default location throughout inventory workflows'
type: 'bugfix'
created: '2026-10-12'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

Operators must always have a default location when loaning or returning equipment, including immediately after annual reset or recovery import. Maintain a valid active shared default at startup and after location mutations/imports: preserve an explicit valid choice, otherwise prefer active צוללת, then the lowest-ID active location. Reject imports and location mutations that would leave no active locations, atomically; never silently create or reactivate a location. Loan and issue dialogs select the configured default when it has projected stock, otherwise an eligible active source; returns use the shared default. Preserve operator overrides and stock validation. No compatibility work or migration is required. Leave the existing deferred-work.md edit untouched.

</frozen-after-approval>

## Implementation Notes

Bounded change with no live data operations or schema/API changes. Extract startup selection into a shared database helper, invoked inside existing location/import transactions and a startup transaction after validation. Reject empty/all-archived catalogs. Retire before selecting replacement. Keep reads side-effect free. Update borrower and consumable preselection, including staged availability. Update README and regression expectations; test imports without restart, explicit defaults, retirement, empty/archived catalogs, transaction rollback, projected stock, and real browser import/loan/return behavior. Run suite, typecheck, lint, build and blind review. Or explicitly chose rejection of operations leaving no active locations; replaced the provisional automatic creation/reactivation policy before completion.


Implemented a single transaction-scoped selection helper, called after location replacement/mutation and after startup validation. Explicit defaults remain intact; missing defaults select active צוללת then lowest ID. Empty/all-archived imports and last-active retirement fail with an actionable Hebrew domain error and roll back. No new location is synthesized or reactivated. Loan and issue dialogs respect projected stock and prefer the shared default even when it is not first in the list. Existing return preselection now receives a maintained default. Updated documentation and old assertions that intentionally required null defaults. No unrelated edits or live databases were modified.

## Review Triage Log

- Medium, resolved: automatically reactivating the last archived home made retirement report an action that was undone. Or chose rejection of all operations leaving no active location; the final transactional helper rejects these mutations and imports. Tests prove no state/epoch change, retry rejection, and later successful retirement/replay after another location is added.
- Low, patched: initial preference tests put the default first. Both dialog matrices now include two stocked sources with the configured default second.
- Low, patched: borrower fallback lacked staged-operation coverage. Added exhaustion by a staged loan and eligibility created by a staged usable return.
- Low, patched: failure injection covered reset only. Both reset and recovery now prove full snapshot and ledger epoch rollback after default-selection failure.
- Low, patched: last-location archival through the retirement command was missing. Both archive and delete rejection/retry paths are covered, alongside the older update and save APIs.
- Low, superseded: automatically creating a replacement home needed stronger deleted-highest-ID coverage. The final policy never creates replacement locations, so that new allocation path and its obsolete tests were removed.

Independent follow-up review found no remaining actionable correctness issues. No deferred findings; deferred-work.md remains untouched.

## Completion Evidence

643 tests passed across 44 files. Three Chromium scenarios passed, including reset and recovery XLSX imports with no default followed immediately by saved borrowing and returning without location clicks. Both TypeScript configurations, repository ESLint, changed-file formatting, production build, and diff whitespace checks passed. Tests used temporary databases; no live data was changed. Desktop suite was not run. The pnpm launcher attempted an unavailable version download, so equivalent checks used the existing installed Node tool entrypoints; Playwright used a temporary config with the same local test server invoked directly. API/browser tests required approved local port access outside the sandbox. Two transient HTTP 501s in an earlier full run passed in isolation and in the final full suite.
