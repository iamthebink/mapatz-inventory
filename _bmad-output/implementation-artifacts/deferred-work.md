- source_spec: none
  summary: Add standardized catalog XLSX/CSV import and export for items, borrowers, and locations.
  evidence: Catalog files support spreadsheet analysis and editing, with imported changes recorded as admin events. Split from the initial core workflow so editable spreadsheet interchange can be reviewed and shipped independently after the local transaction model is proven.

- source_spec: none
  summary: Add whole-database XLSX import and export for portable backup and recovery.
  evidence: Whole-database files include the immutable ledger and history and restore by atomically replacing the database; they are not an ordinary editing surface and do not support partial import, merge, or selective history replacement. Split from catalog interchange so its disaster-recovery semantics can be designed and validated independently.

- source_spec: none
  summary: Add opportunistic encrypted cloud backup and full-database disaster recovery.
  evidence: Split from the initial core workflow because remote backup infrastructure is independent of front-desk checkout and return behavior.

- source_spec: none
  summary: Add operational reports for outstanding loans, daily activity, inventory by location, damage, and loss.
  evidence: Split from the initial core workflow because reporting can be derived from the stable ledger after the core transaction paths are validated.

- source_spec: `/Users/orba/projects/mapatz-inventory/_bmad-output/implementation-artifacts/spec-formatting-and-linting.md`
  summary: Decide whether CI should enforce formatting, zero-warning linting, typechecking, and tests on every change.
  evidence: The repository now has reproducible local gates but no checked-in CI workflow; enforcement policy and hosting integration are independently shippable and outside this formatting/linting baseline.

- source_spec: `/Users/orba/projects/mapatz-inventory/_bmad-output/implementation-artifacts/spec-formatting-and-linting.md`
  summary: Decide whether to adopt type-aware strict TypeScript linting and eliminate the repository-wide `no-explicit-any` exception.
  evidence: ESLint currently uses non-type-aware recommended rules and explicitly disables `@typescript-eslint/no-explicit-any`; strengthening that policy would surface existing database-boundary typing work and requires a deliberate scope decision rather than a mechanical cleanup.

- source_spec: `/Users/orba/projects/mapatz-inventory/_bmad-output/implementation-artifacts/spec-toast-notifications.md`
  summary: Replace the singleton toast state with a severity-aware notification queue.
  evidence: Concurrent background and operation feedback can overwrite a more actionable message; the behavior predates the toast conversion, and queueing introduces independently reviewable ordering, stacking, and dismissal policy.

- source_spec: `/Users/orba/.codex/worktrees/9062/mapatz-inventory/_bmad-output/implementation-artifacts/spec-admin-mode-ux.md`
  summary: Add DOM-capable interaction tests for admin-mode focus, cancellation, expiry, visibility, and activity/action ordering.
  evidence: The current Vitest setup is Node-only. Static SSR and API tests cover presentation and session contracts, while focus trapping, pending dismissal, live announcements, foreground reconciliation, trusted-event filtering, and browser event races were verified manually. Automating those flows requires a DOM or end-to-end test harness beyond this quick feature.

- source_spec: `/Users/orba/projects/mapatz-inventory/_bmad-output/implementation-artifacts/spec-toast-bottom-entry-exit-animation.md`
  summary: Pause success-toast auto-dismiss while the toast is hovered or contains keyboard focus.
  evidence: The existing six-second success timeout can still remove a toast while a pointer or keyboard user is interacting with it; this accessibility improvement predates and is independent of the requested position and exit-motion change.

- source_spec: `/Users/orba/projects/mapatz-inventory/_bmad-output/implementation-artifacts/spec-in-app-dialogs.md`
  summary: Preflight workbook size and XLSX type before presenting destructive import confirmation.
  evidence: The file picker filters for XLSX but does not enforce the server's 10 MB limit or reject programmatically supplied files before confirmation; this behavior predates the in-app dialog conversion and remains protected by server validation.

- source_spec: `/Users/orba/projects/mapatz-inventory/_bmad-output/implementation-artifacts/spec-in-app-dialogs.md`
  summary: Add conflict-safe reconciliation for entity and loan snapshots held during edits.
  evidence: Return and location-edit submissions can use row state captured before another session refreshes or archives the record; the baseline native-prompt paths had the same last-write behavior, and resolving it requires a broader concurrency policy rather than a dialog-only patch.

- source_spec: `/Users/orba/projects/mapatz-inventory/_bmad-output/implementation-artifacts/spec-simplify-borrower-desk-actions.md`
  summary: Measure borrower-directory scale and introduce pagination or virtualization only if production roster size causes unacceptable API or DOM latency.
  evidence: Review identified a plausible unbounded-roster risk, but the repository contains no production borrower-count distribution, performance threshold, or failing measurement proving that the all-active directory is currently impractical.
- source_spec: `/Users/orba/projects/mapatz-inventory/_bmad-output/implementation-artifacts/spec-route-backed-top-navigation.md`
  summary: Add server-level regression coverage for direct SPA route requests.
  evidence: Route refreshes rely on the existing Express catch-all serving the production index, but current integration fixtures disable web serving and the source tree has no built index artifact; protecting this without coupling tests to generated output needs a dedicated static-root fixture seam.
- source_spec: `/Users/orba/projects/mapatz-inventory/_bmad-output/implementation-artifacts/spec-frontdesk-route-alias.md`
  summary: Add production-static-server regression coverage for the `/frontdesk` SPA alias.
  evidence: Browser coverage proves direct entry through the development server, while the production Express catch-all is generic and unchanged; testing its built-index response cleanly still requires the previously identified static-root fixture seam.

- source_spec: `_bmad-output/implementation-artifacts/spec-tag-derived-release-version.md`
  summary: Suppress setup navigation errors caused by an intentional quit during early desktop startup.
  evidence: A version-only probe requested app.quit before setup.html completed loading; its isolated desktop.log records quit then ERR_FAILED and a blocking failure dialog. Normal setup/relaunch tests pass. The precise early-quit sequence should become a regression test before adjusting lifecycle handling.
- source_spec: `_bmad-output/implementation-artifacts/spec-restore-borrower-card-side-by-side-work-area.md`
  summary: Reconcile the borrower work area's separate bordered sections with the older UX visual spine's continuous two-half surface.
  evidence: The existing `.operational-section` card borders and 16px segment gap predate this orientation change; restoring columns keeps them. A continuous surface with one vertical separator would be a separate styling change.
- source_spec: `_bmad-output/implementation-artifacts/spec-restore-borrower-card-side-by-side-work-area.md`
  summary: Add the older UX visual spine's separator between item search and the borrower work segment.
  evidence: The existing search/work segment has no explicit horizontal divider and this orientation change does not alter that boundary.

- source_spec: `_bmad-output/implementation-artifacts/spec-operator-damage-restoration-in-management.md`
  summary: Keep borrower save-and-close recovery guarded against card dismissal and browser Back until committed truth is verified.
  evidence: In the already-committed borrower workflow, `operationLocks` permits exit in `refresh-required` for save-and-close while the card remains mounted; hidden-card recovery also removes its history sentinel before verification.
- source_spec: `_bmad-output/implementation-artifacts/spec-operator-damage-restoration-in-management.md`
  summary: Persist the borrower post-commit truth-verification obligation across page reloads.
  evidence: The prior borrower workflow clears its frozen attempt after confirmed commit, but its refresh/reload recovery lock exists only in component state and disappears on reload.
- source_spec: `_bmad-output/implementation-artifacts/spec-operator-damage-restoration-in-management.md`
  summary: Make borrower directory recovery requests single-flight with visible progress.
  evidence: Existing recovery buttons stay enabled during refresh/reload and handlers do not reject a repeated start; overlapping snapshots can race and the operator sees no in-progress affordance.
- source_spec: `_bmad-output/implementation-artifacts/spec-operator-damage-restoration-in-management.md`
  summary: Focus the directory recovery control for hidden-card reload as well as refresh.
  evidence: The prior borrower workflow's startup focus effect handles only hidden `refresh-required`, so a hidden `reload-required` phase falls through to borrower search instead.
- source_spec: `_bmad-output/implementation-artifacts/spec-operator-damage-restoration-in-management.md`
  summary: Reconcile inventory action state after a committed mutation whose general snapshot refresh fails.
  evidence: Existing `action()` warns that refresh failed but releases pending state with stale quantities, allowing a second non-idempotent repair or other inventory action before a successful refresh.
- source_spec: `_bmad-output/implementation-artifacts/spec-inventory-management.md`
  summary: Decide whether catalog metadata edits require concurrent edit detection.
  evidence: Metadata-only item saves use last-writer-wins as before this change. The stock snapshot protects changed absolute counts, but does not detect concurrent name, alias, package-size or location edits.
- source_spec: `_bmad-output/implementation-artifacts/spec-consumable-disbursement.md`
  summary: Validate whether borrower-card consumable issuance needs explicit anonymity copy.
  evidence: The card labels the action as consumable issuance and keeps it out of holdings, but an operator might still infer recipient attribution from the card context. A brief operator usability check would settle whether extra copy is needed.

- source_spec: `spec-password-recovery-redux.md`
  summary: Investigate two frozen-operation desktop recovery failures found by the broad recovery filter.
  evidence: “unknown recovery blocks quit…” and “non-desk reload blocks…” failed in untouched tests during broad packaged verification; password-specific test passed. Baseline comparison has not been run, so pre-existing status is unverified.

- source_spec: `_bmad-output/implementation-artifacts/spec-internal-item-identity.md`
  summary: Update README recovery event vocabulary and report prose for found_returned_damaged.
  evidence: The baseline README omits this accepted event kind and describes found-return selection as found_returned only; item-identity changes preserve these event semantics.
