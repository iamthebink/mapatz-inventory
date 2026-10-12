# Deferred work

Audited on 2026-10-12 against `239dc679c3d1711c773c2d459a6b30a4c02d7527`.
This is an evidence-based backlog, not a list of confirmed defects in every entry. `reproduced` means a fault-injection probe demonstrated the behavior; `source-verified` means current code was inspected; `planned` and `unverified` are explicitly different.

## Before tagging: borrower recovery

Recommendation: resolve the following three functional issues before tagging. The write has already committed in these scenarios; the demonstrated defects concern verification, stale UI state, and recovery ownership, not proven ledger corruption. Unknown-write replay and desktop quit protection passed their separate tests.

- source_spec: `_bmad-output/implementation-artifacts/spec-operator-damage-restoration-in-management.md`
  summary: Keep borrower save-and-close recovery guarded against card dismissal and browser Back until committed truth is verified.
  evidence: Fault-injection probe held the desk-snapshot response after a committed save-and-close, then called requestNavigation. The borrower card disappeared while verification was pending. BorrowerWorkflow.requestExit consults operationLocks.exit, which is false in refresh-required; closeCard resets the operation. The hidden recovery path also removes its history sentinel, and App popstate does not consult the borrower navigation handle. Card dismissal was reproduced; the browser-Back branch was source-traced, not separately browser-tested.
  status: open — reproduced dismissal; source-verified Back path
  priority: pre-tag

- source_spec: `_bmad-output/implementation-artifacts/spec-operator-damage-restoration-in-management.md`
  summary: Make borrower directory recovery requests single-flight with visible progress.
  evidence: Fault-injection probe failed the first post-commit snapshot, held the retry response, and clicked the directory recovery button twice. Three snapshot requests ran (initial failure plus two overlapping retries), rather than two. refreshOperation/reloadOperation do not stop when their reducer rejects a repeated start; handlers apply results against captured state. Directory buttons remain enabled and lack in-flight progress.
  status: open — reproduced refresh overlap; source-verified reload counterpart
  priority: pre-tag

- source_spec: `_bmad-output/implementation-artifacts/spec-operator-damage-restoration-in-management.md`
  summary: Persist the borrower post-commit truth-verification obligation across page reloads.
  evidence: Fault-injection probe committed, failed the truth refresh, then remounted BorrowerWorkflow with the same storage. Frozen storage was already empty and borrower search became enabled without completing the prior verification. settle clears the confirmed command before snapshot verification; the remaining obligation exists only in component state. This is a post-commit verification gap, not a failure to persist an unknown write.
  status: open — reproduced
  priority: pre-tag

## Other current reliability and verification work

- source_spec: `_bmad-output/implementation-artifacts/spec-operator-damage-restoration-in-management.md`
  summary: Focus the directory recovery control for hidden-card reload as well as refresh.
  evidence: Fault-injection probe returned a newer ledger epoch after save-and-close, producing hidden-card reload-required, then toggled desk visibility. Focus remained on body instead of the reload button. The focus effect explicitly handles refresh-required only. Recovery remains clickable.
  status: open — reproduced
  priority: low

- source_spec: `_bmad-output/implementation-artifacts/spec-inventory-lost-item-recovery.md`
  summary: Provide diagnostic and safe operator repair for malformed frozen borrower records.
  evidence: Malformed frozen records are returned as invalidKeys by initializeFrozenAttemptRecovery and deliberately keep startup blocked. The packaged non-desk test confirmed this gate. Retrying unchanged corrupt storage cannot repair it; the test manually clears test storage to continue. A production repair path must retain evidence and avoid discarding a possibly committed command.
  status: open — source-verified
  priority: operational recovery

- source_spec: `_bmad-output/implementation-artifacts/spec-inventory-lost-item-recovery.md`
  summary: Reconcile a frozen borrower attempt resolved by another browser tab without requiring reload.
  evidence: resolveFrozenAttempt requires the stored envelope to match byte-for-byte. If another tab resolves and removes it, the live owner remains locked on retry until reload reinitializes. Source verified; no multi-tab browser reproduction in this audit. This is primarily browser-mode usability, while desktop single-instance ownership passed.
  status: open — source-verified
  priority: medium

- source_spec: `_bmad-output/implementation-artifacts/spec-operator-damage-restoration-in-management.md`
  summary: Guard remaining general App mutations after a committed operation whose snapshot refresh fails.
  evidence: The old damage/stock example is obsolete: InventoryManagement now has durable commands and refresh-only recovery. App.action still releases pending and returns success after refresh failure, and serves borrower metadata/archival/creation and workbook imports. Those callers can resume with stale catalog or epoch state; the warning says not to repeat, but there is no recovery lock. Scope any fix to these remaining callers.
  status: open — source-verified
  priority: medium

- source_spec: `_bmad-output/implementation-artifacts/spec-inventory-management.md`
  summary: Decide concurrent-edit policy for item, borrower, and ordinary location metadata.
  evidence: Metadata-only item saves and borrower edits still use last-writer-wins; ordinary location edits have no metadata revision. Quantity writes validate stockRevision; borrower operations validate balances; default-location selection checks captured names/codes. The older generic entity/loan snapshot entry is consolidated here rather than treating guarded returns as unprotected.
  status: open — policy decision, source-verified
  priority: medium with multiple operators

- source_spec: `_bmad-output/implementation-artifacts/spec-multi-location-stock.md`
  summary: Align Unicode location-name uniqueness between database saves and workbook validation.
  evidence: Current locations schema uses SQLite NOCASE uniqueness, while recovery validation keys location names with toLocaleLowerCase(). Non-ASCII case variants such as Greek can therefore be accepted at creation but rejected together on restore. Source verified; the normal recovery suite passes but does not prove this edge case.
  status: open — source-verified
  priority: backup fidelity

- source_spec: `_bmad-output/implementation-artifacts/spec-multi-location-stock.md`
  summary: Preserve configured location codes across workbook recovery.
  evidence: InventoryTransferService recovery still constructs recovered-location-N codes, while Recovery Locations exports names rather than preserving configured codes. Event snapshots retain their original codes. Source verified; ordinary round-trip tests passing does not imply exact location-code fidelity.
  status: open — source-verified
  priority: backup fidelity

- source_spec: `_bmad-output/implementation-artifacts/spec-internal-item-identity.md`
  summary: Update README recovery event vocabulary and report prose for found_returned_damaged.
  evidence: README still omits found_returned_damaged from its transition table and event list, filters found returns using found_returned alone, and says the summary is unimplemented. Current code supports both found-return kinds and /period-summary. Update these concrete stale statements.
  status: open — source-verified
  priority: documentation

- source_spec: `_bmad-output/implementation-artifacts/spec-route-backed-top-navigation.md`
  summary: Add production Express static-route regression coverage, including /frontdesk.
  evidence: src/server/app.ts uses a generic index.html catch-all; current integration tests do not exercise production static serving. Development-server browser coverage does not verify that branch. Consolidates the separate /frontdesk entry; use a temporary static-root fixture rather than depending on build output.
  status: open — test gap, source-verified
  priority: medium for browser deployment

- source_spec: `_bmad-output/implementation-artifacts/spec-admin-mode-ux.md`
  summary: Audit and cover remaining admin-session expiry, visibility, and trusted-activity ordering scenarios.
  evidence: The original claim that Vitest is Node-only is obsolete: jsdom/admin/dialog tests and Playwright now exist. Current admin tests cover focus and cancellation; this audit did not establish complete UI coverage of expiry, foreground reconciliation, and activity/request races. Identify specific missing cases using the existing harness before adding tests.
  status: open — narrowed coverage audit, not a verified runtime defect
  priority: test coverage

- source_spec: `_bmad-output/implementation-artifacts/spec-tag-derived-release-version.md`
  summary: Suppress setup navigation errors caused by an intentional quit during early desktop startup.
  evidence: A version-only probe requested app.quit before setup.html completed loading; its isolated desktop.log records quit then ERR_FAILED and a blocking failure dialog. Normal setup/relaunch tests pass. The precise early-quit sequence should become a regression test before adjusting lifecycle handling.
  status: open — historical observation, not reproduced in this audit
  priority: low

## Product decisions and lower-priority improvements

- source_spec: none
  summary: Define the remaining editable catalog spreadsheet interchange scope.
  evidence: Workbook export/reset/recovery and borrower XLSX preview/commit already exist. General editable CSV/XLSX upsert interchange for items and locations is not the same as destructive reset/recovery. Decide the remaining desired formats and merge semantics before treating this as an unimplemented whole feature.
  status: planned — partially implemented

- source_spec: none
  summary: Add opportunistic encrypted cloud backup and full-database disaster recovery.
  evidence: No cloud-backup adapter was found in the current desktop backup path. README documents manual off-device profile copying; local pre-migration backups exist. Before field use, validate an off-device restore procedure. Automatic encrypted cloud backup remains optional product scope.
  status: planned — off-device procedure remains an operational requirement

- source_spec: none
  summary: Define reporting needs beyond the implemented summary, borrower holdings, ledger, and location inventory.
  evidence: The app now has /period-summary, borrower balances, ledger views and inventory by location. The original all-or-nothing reporting entry is stale. Additional daily/report exports or specialized damage/loss reports require a concrete operator need.
  status: planned — partially implemented

- source_spec: `_bmad-output/implementation-artifacts/spec-formatting-and-linting.md`
  summary: Decide whether to adopt type-aware strict TypeScript linting and eliminate the repository-wide `no-explicit-any` exception.
  evidence: ESLint currently uses non-type-aware recommended rules and explicitly disables `@typescript-eslint/no-explicit-any`; strengthening that policy would surface existing database-boundary typing work and requires a deliberate scope decision rather than a mechanical cleanup.
  status: open — source-verified

- source_spec: `_bmad-output/implementation-artifacts/spec-toast-notifications.md`
  summary: Replace the singleton toast state with a severity-aware notification queue.
  evidence: Concurrent background and operation feedback can overwrite a more actionable message; the behavior predates the toast conversion, and queueing introduces independently reviewable ordering, stacking, and dismissal policy.
  status: open — source-verified

- source_spec: `_bmad-output/implementation-artifacts/spec-toast-bottom-entry-exit-animation.md`
  summary: Pause success-toast auto-dismiss while the toast is hovered or contains keyboard focus.
  evidence: The existing six-second success timeout can still remove a toast while a pointer or keyboard user is interacting with it; this accessibility improvement predates and is independent of the requested position and exit-motion change.
  status: open — source-verified

- source_spec: `_bmad-output/implementation-artifacts/spec-in-app-dialogs.md`
  summary: Preflight workbook size and XLSX type before presenting destructive import confirmation.
  evidence: The file picker filters for XLSX but does not enforce the server's 10 MB limit or reject programmatically supplied files before confirmation; this behavior predates the in-app dialog conversion and remains protected by server validation.
  status: open — source-verified

- source_spec: `_bmad-output/implementation-artifacts/spec-simplify-borrower-desk-actions.md`
  summary: Measure borrower-directory scale and introduce pagination or virtualization only if production roster size causes unacceptable API or DOM latency.
  evidence: Review identified a plausible unbounded-roster risk, but the repository contains no production borrower-count distribution, performance threshold, or failing measurement proving that the all-active directory is currently impractical.
  status: planned — measure before adding pagination

- source_spec: `_bmad-output/implementation-artifacts/spec-restore-borrower-card-side-by-side-work-area.md`
  summary: Reconcile the borrower work area's separate bordered sections with the older UX visual spine's continuous two-half surface.
  evidence: The existing `.operational-section` card borders and 16px segment gap predate this orientation change; restoring columns keeps them. A continuous surface with one vertical separator would be a separate styling change.
  status: planned — optional visual decision, not a correctness defect

- source_spec: `_bmad-output/implementation-artifacts/spec-restore-borrower-card-side-by-side-work-area.md`
  summary: Add the older UX visual spine's separator between item search and the borrower work segment.
  evidence: The existing search/work segment has no explicit horizontal divider and this orientation change does not alter that boundary.
  status: planned — optional visual decision, not a correctness defect

- source_spec: `_bmad-output/implementation-artifacts/spec-consumable-disbursement.md`
  summary: Validate whether borrower-card consumable issuance needs explicit anonymity copy.
  evidence: The card labels the action as consumable issuance and keeps it out of holdings, but an operator might still infer recipient attribution from the card context. A brief operator usability check would settle whether extra copy is needed.
  status: planned — operator usability check

## Closed or consolidated in this audit

- **Whole-database XLSX inventory recovery:** implemented as the current logical inventory workbook export/recovery contract (`src/io/workbook.ts`, `src/domain/import-export.ts`, `/workbook/recovery`). Secrets/settings follow the documented preservation policy; this is not a raw profile backup. Recovery suite passed. Original source: initial core-workflow split.
- **CI enforcement decision:** implemented in `.github/workflows/ci.yml`: formatting, lint, both typechecks, tests, browser tests, build, plus a desktop OS matrix. Workflow existence was verified; this audit did not inspect the latest hosted run. Source: `spec-formatting-and-linting.md`.
- **No DOM test harness:** obsolete premise; jsdom and Playwright are present. Remaining admin-session coverage work is narrowed above. Source: `spec-admin-mode-ux.md`.
- **Generic entity/loan snapshot reconciliation:** consolidated into metadata concurrency above. Current borrower balance validation and inventory stock revisions make the old blanket description inaccurate. Source: `spec-in-app-dialogs.md`.
- **Separate /frontdesk static regression:** consolidated into the production SPA-route test entry above. Source: `spec-frontdesk-route-alias.md`.
- **Two reported desktop frozen-recovery failures:** not reproduced on the fresh macOS arm64 package at the audited revision. Both “unknown recovery blocks quit…” and “non-desk reload blocks…” passed. Adjacent lost-response replay and dirty/saving quit scenarios also passed. This does not establish whether the old failures were flakes, obsolete package bits, or platform-specific. Windows and Intel macOS were not rerun here. Source: `spec-password-recovery-redux.md`.
- **Input border contrast:** closed by Or after visual inspection; retain current borders. Original observation was approximately 1.58:1 on paper versus the previous 1.32:1. This preserves the already accepted, previously uncommitted decision. Source: `spec-desert-theme-and-playful-identity.md`.

## Audit evidence and limits

- Fresh package built with Node 24.19.0 and Electron Forge from the audited source. The existing October 7 package was not used. pnpm bootstrap was unavailable; a temporary wrapper mapped only `pnpm build` to the equivalent `npm run build`, then Forge used the build script's npm installer settings. No dependency or packaging source was changed.
- Desktop commands: `playwright test -c playwright.desktop.config.ts -g 'unknown recovery blocks quit|non-desk reload blocks'` (2 passed) and `-g 'lost response survives replacement|dirty staged quit requires discard'` (2 passed). Tests used disposable profiles, not the live profile.
- Existing verification: `vitest run tests/web/borrower-workflow.test.tsx tests/web/borrower-workflow-state.test.ts tests/web/borrower-workflow-recovery.test.ts tests/web/period-summary-card.test.tsx tests/web/admin-mode.test.tsx tests/domain/recovery.test.ts` — 148 passed across six files.
- Four temporary borrower fault-injection probes deliberately asserted the desired safe behavior and failed at those assertions: card remained open (actual null), single-flight reads (actual 3 versus 2), remount search locked (actual enabled), and reload-control focus (actual body). They were removed from the working test tree after the audit; production code and committed test expectations were not changed to conceal the failures. The reproduction steps are in the entries above.
- Machine-local diagnostics: `/tmp/mapatz-desktop-recovery-audit.log`, `/tmp/mapatz-desktop-durability-audit.log`, `/tmp/mapatz-existing-recovery-verification.log`, `/tmp/mapatz-borrower-recovery-audit-final.log`, and `/tmp/mapatz-release-audit-package-retry.log`. These temporary logs are supporting evidence, not durable release artifacts.
- This was a targeted readiness audit, not a full release certification. No production fixes, release tag, push, or publication occurred. Remaining non-recovery entries were checked against source or explicitly left as planned/unverified.
