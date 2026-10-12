---
title: 'Preserve borrower recovery until committed truth is verified'
type: 'bugfix'
created: '2026-10-12'
status: 'done'
baseline_commit: '6b04ace5f248f022c141727c1ec5058ff0b533eb'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/AGENTS.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Confirmed borrower operations can lose their pending verification through navigation or reload. Recovery buttons also permit overlapping reads and stale completions.

**Approach:** Keep a durable verification obligation after commit, guard navigation until it resolves, and serialize recovery reads. Fix the three pre-tag borrower recovery entries, verify them, and commit locally.

## Boundaries & Constraints

**Always:** Preserve exact-key replay for unknown writes. Once a committed verification record is durable, recovery is read-only. Preserve reviewed save-and-close presentation, Hebrew UI conventions, and toast feedback. All consumers of shared recovery storage must honor its lifecycle, including desktop startup and inventory lost-item recovery.

**Never:** Add compatibility machinery, database migrations, ordinary draft persistence, unrelated backlog fixes, release tags, pushes, or publication. Never rebind an old borrower context to a same-number borrower in a replacement ledger.

## I/O & Edge-Case Matrix

| Scenario            | Input / State                                               | Expected Output / Behavior                                                            | Error Handling                                                                       |
| ------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Committed write     | Attributed successful operation response                    | Atomically replace its frozen command with durable verification ownership             | Failed replacement remains blocking and safely recoverable                           |
| Pending truth       | Snapshot pending or failed                                  | Guard card dismissal, tab navigation, Back, reload warning, and desktop quit          | Retry with toast feedback; retain obligation                                         |
| Repeated retry      | Automatic or manual read already running                    | One request per active recovery owner; controls disabled with progress                | No stale completion overwrites current state                                         |
| Valid truth         | Same epoch, revision newer than dispatch                    | Release obligation only after verified storage removal; finish save or save-and-close | Removal failure keeps read-only recovery                                             |
| Reload/remount      | Durable committed marker exists                             | Block normal work until read verification completes                                   | Never POST the known committed operation                                             |
| Invalid truth       | Stale, malformed, unauthorized, or failed read              | Keep recovery locked                                                                  | Visible retry and toast; no false success                                            |
| Replacement/absence | Authoritative newer ledger, or borrower no longer available | Retire old context, refresh directory, explain via toast                              | Do not install replacement borrower into old card; uncertain evidence remains locked |
| Unknown write       | Lost response or unconfirmed storage transition             | Existing exact-envelope replay semantics retained                                     | No new idempotency key                                                               |

</frozen-after-approval>

## Code Map

- `src/web/borrower-workflow-recovery.ts`: parser, enumeration, `settle`, dispatch/resolve, initialization. Currently clears confirmed command before verification. Separate known write outcome from completed verification; keep one storage key with explicit lifecycle variants.
- `src/web/borrower-workflow-state.ts`: `operationLocks`, refresh/reload request identity, epoch/revision acceptance. Exit currently unlocked during committed refresh/reload.
- `src/web/BorrowerWorkflow.tsx`: `applyOperationResult`, refresh/reload handlers, requestExit, history sentinel, beforeunload, and four recovery controls. Retry handlers currently fetch even when reducer rejects start; completions use captured state.
- `src/web/App.tsx`: popstate bypasses borrower navigation handle; click navigation and desktop close already consult it.
- `src/web/DesktopStartup.tsx`, `src/web/useLostItemRecovery.ts`: shared recovery initializer owners; management currently interprets retained records as unknown writes.
- `src/web/api.ts`, `src/domain/inventory.ts`, `src/server/routes.ts`: snapshot read and typed errors. Snapshot rejects archived borrowers; authoritative absence/replacement handling must avoid impossible retry loops. Use a focused transactional read if existing reads cannot establish safe terminal evidence.
- `tests/web/borrower-workflow*.test.*`, `tests/web/period-summary-card.test.tsx`, inventory recovery and desktop tests: regression coverage. Audit probes in `/tmp/mapatz-borrower-recovery-audit.test.tsx` are optional reproduction references, not a dependency.
- `_bmad-output/implementation-artifacts/deferred-work.md`: three pre-tag entries; close with actual verification evidence, preserve remaining backlog.

## Tasks & Acceptance

**Execution:**

- [x] Extend shared durable recovery lifecycle and validation; adapt every caller without conflating a committed outcome with cleared verification ownership.
- [x] Guard borrower navigation and preserve the history sentinel during committed verification.
- [x] Unify automatic/manual refresh ownership, reject duplicate starts synchronously, check live request identity on completion, and show disabled progress controls.
- [x] Cover matrix boundaries with meaningful helper, reducer, component, browser, and packaged desktop tests.
- [x] Update the three deferred entries, record verification limits, review changes, and commit.

**Acceptance Criteria:**

- Given confirmed save-and-close awaiting truth, navigating away cannot discard recovery ownership.
- Given a failed initial truth read, repeated retry interaction starts exactly one additional read until settlement.
- Given a remount or startup on another desktop route, a retained committed record gates work and completes through reads without another operation POST.
- Existing unknown-write replay, lost-item recovery, period-summary return, and desktop close protection remain correct.

## Implementation Notes

- Approved by Or on 2026-10-12. Implemented the shared same-key committed marker, guarded exit, synchronous request ownership, transactional absence evidence, and all startup consumers.
- Matrix coverage: committed/unknown write attribution and storage failures in helper tests; pending navigation and duplicate retries in component/browser tests; cleanup failure and remount in component tests; stale/malformed/failed reads in helper tests; absence in API tests and replacement in reducer/browser tests; non-desk reload and quit in packaged tests.
- Full suite: 694 tests across 45 files passed. Both TypeScript checks, ESLint, formatting, production build, fresh Node 24 packaging passed. Five macOS arm64 desktop recovery/quit tests and 34 Chromium borrower/inventory tests passed. Initial desktop unload-dialog failure was corrected by keeping native startup quit protection in its IPC guard; browser startup unload warning remains. Windows/Intel macOS not rerun.
- Parent inspection found and fixed navigation guard composition before review; the existing dirty-consumable Back regression passes. Final commit remains the workflow completion step.

- Review patches verified: uncertain cleanup, native history, blocked storage startup, truthful management feedback, retained retirement warning, HTTP absence fallback, reload concurrency, and late completion. All in-scope findings patched; pre-existing unbounded transport duration recorded separately in the deferred ledger. Optional diagnostic result taxonomy rejected as unnecessary scope.
- Final evidence: 694 Vitest tests / 45 files, 34 Chromium tests, five freshly packaged macOS arm64 recovery tests; both typechecks, ESLint, formatting, build and package pass. Test logs are in `/tmp/mapatz-committed-*-final.log`; these are supporting local diagnostics.

## Spec Change Log

## Review Triage Log

| Finding                                          | Verdict | Evidence and route                                                                                                                                                                           |
| ------------------------------------------------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Blind 1: absent marker after uncertain cleanup   | medium  | Verified remove succeeds/read-back throws then initial exact-marker check rejects null forever. Patch initial ownership check; reverify truth before releasing.                              |
| Blind 2: Back rewrites history                   | medium  | Verified popstate replaces destination then navigateToTab pushes, truncating Forward. Patch local traversal completion and regress Back/Forward.                                             |
| Blind 3: false unsent feedback                   | medium  | Marker transition uses write storage-failure after transport; management's shared branch claims no send. Patch feedback to avoid false certainty.                                            |
| Blind 4: inaccessible localStorage startup       | medium  | Direct getter can throw before initializer returns, leaving loading with newly guarded navigation. Patch catch and retry state.                                                              |
| Blind 5: unbounded read duration                 | medium  | workflowRead already had no timeout before this change; a hanging transport remains pending. Defer transport timeout policy separately; durable recovery survives reload.                    |
| Blind 6: generic pending reason                  | low     | Retry feedback remains correct and does not falsely claim success. Finer diagnostic categories add a public result surface without changing recovery safety; reject this optional expansion. |
| Blind 7: retirement reason lost on refresh retry | medium  | refresh(true) failure stores only refreshOnly; retry calls refresh() with false default. Patch retained reason.                                                                              |
| Blind 8: absence adapter tests                   | medium  | Isolated endpoint/verifier tests bypass the new fallback adapter. Patch end-to-end mocked HTTP chain and negative branches.                                                                  |
| Blind 9: reload/late completion coverage         | medium  | Refresh duplicate test does not execute reload branch or late owner completion. Patch targeted component coverage.                                                                           |
| Edge 1: Back route cycle                         | medium  | Independently confirmed same replace-plus-push defect as Blind 2; same patch.                                                                                                                |
| Edge 2: uncertain cleanup deadlock               | medium  | Independently confirmed same null-marker rejection as Blind 1; same patch.                                                                                                                   |
| Verification 1: missing absence adapter proof    | medium  | Pre-verified coverage gap: replacing catch with throw leaves isolated assertions unchanged. Same patch as Blind 8.                                                                           |

## Design Notes

Intent gaps: none. Irreversible actions: none beyond the requested local commit. Footprint: shared recovery lifecycle, borrower UI/navigation, its startup consumers, tests, and ledger documentation; possibly a focused read contract. This cross-consumer lifecycle warrants the full dispatch route.

Replace the stored envelope in place; never remove it before persisting verification. A read-only marker must survive successful reads whose storage cleanup fails. Initialization must recognize both unresolved commands and committed verification records. A bare failed request is not authoritative evidence of borrower absence or ledger replacement.

## Verification

- Run targeted recovery, workflow, state, summary, inventory, and API tests, then the full Vitest suite.
- Run both TypeScript checks, ESLint, formatting checks, and production build.
- Run browser navigation/retry regressions and freshly packaged macOS desktop recovery/quit scenarios with disposable profiles, including committed verification across restart or reload. Report other platforms as untested.
