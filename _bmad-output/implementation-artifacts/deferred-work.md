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
