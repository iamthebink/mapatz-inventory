---
title: 'Operator Damage Restoration in Management'
type: 'feature'
created: '2026-09-22'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: c241fea81b0babf06dab1096d748b6113dc83c71
checkpoint_ref: refs/codex/checkpoints/borrower-contract-pre-reconcile-2026-09-22
context:
  - '_bmad-output/specs/spec-borrower-equipment-actions/SPEC.md'
  - '_bmad-output/specs/spec-borrower-equipment-actions/interaction-contract.md'
  - '_bmad-output/specs/spec-borrower-equipment-actions/integration-notes.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Damaged equipment already returned to shared inventory cannot be restored by an operator, even though the existing management card is the approved destination. The current blanket admin-only copy and route gate obscure the distinction between restoration and disposal.

**Approach:** Reuse `ניהול → מלאי ופגומים → טיפול בפגום`. Let operators restore damaged stock to usable; show them a fixed restoration action. Keep administrators' repair/write-off selection and enforce administrator-only write-off at the server.

## Boundaries & Constraints

**Always:** Restore only existing damaged stock; credit usable and debit damaged by the same quantity with a `repaired` event. Leave borrower balances unchanged. Validate quantity and note, respect pending/session reconciliation, preserve admin write-off, existing toasts and applicable confirmation. If an admin selected write-off and their role expires, never silently turn that intent into repair.

**Never:** Add a new inventory page or borrower-card repair, broaden write-off authorization, open unrelated stock-addition/catalog/import/loss actions, rewrite history, or infer ownership of damaged stock by a borrower.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|---------------------------|----------------|
| Operator restore | Damaged q≥1, valid item/note | Existing card submits `repair`; damaged −q, usable +q, borrower unchanged | Invalid/excessive q leaves ledger and stock unchanged |
| Operator direct write-off | POST `/damage` with `write_off` | 403 and no event or stock mutation | Role checked after request validation, before domain action |
| Administrator write-off | Admin selects `write_off` | Existing disposal workflow remains available | Existing validation/feedback applies |
| Expiring admin role | `write_off` selected, role expires/reconciles | UI cannot submit write-off and does not convert it to repair | Server rejects stale write-off; restoration requires explicit fresh intent |
| Other management actions | Operator opens stock tab | Restoration enabled, protected actions still gated, copy truthful | No blanket “screen read-only” message |

</frozen-after-approval>

## Code Map

- `src/web/App.tsx` -- management stock tab already visible to operators; `טיפול בפגום` ActionCard at ~1096 uses `adminActionsEnabled`, always shows repair/write-off selector, and displays blanket `PermissionNote`. Reuse `action()` single-flight, activity-ordering, refresh, and toast behavior. Use an explicit resolution state so role downgrade cannot replace a selected write-off with implicit repair; keep unrelated card gates.
- `src/server/routes.ts` -- `/damage` at ~592 currently has route-level admin gate. Parse strict request, allow `repair` for authenticated operator/admin and reject `write_off` unless the current session role is admin, before `resolveDamage`.
- `src/domain/inventory.ts` -- `resolveDamage` already atomically appends `repaired`/`written_off` after damaged-balance validation; no event/schema change for this slice.
- `src/server/session.ts`, `src/web/api.ts` -- session expiry/downgrade and 401/403 reconciliation already exist; preserve selected write-off intent across downgrade rather than implicitly rewriting it.
- `tests/integration/api.test.ts`, `tests/web/app-dialogs.test.tsx` -- add role/expiry/no-mutation, exact submitted resolution, stale write-off intent, reconciliation lock, and operator/admin card tests. Existing web mock starts in admin mode and exposes `expireAdmin`/`restoreAdmin` helpers.
- `_bmad-output/implementation-artifacts/deferred-work.md` -- reconcile the stale Q1 placement entry now that the existing card is approved; preserve all unrelated entries.

## Tasks & Acceptance

**Execution:**
- [x] `src/server/routes.ts` -- gate `/damage` by parsed resolution so operator repair succeeds and write-off remains administrator-only.
- [x] `src/web/App.tsx` -- enable operator restoration, keep fixed repair UI for operators and selector for admins, prevent stale write-off conversion, and scope permission copy without changing other gates.
- [x] `tests/integration/api.test.ts`, `tests/web/app-dialogs.test.tsx` -- test every matrix row, including role expiry/reconciliation and no stock/ledger mutation on rejection.
- [x] `_bmad-output/implementation-artifacts/deferred-work.md` -- resolve only the obsolete CAP-5/Q1 entry after implementation passes; retain unrelated deferred work.

**Acceptance Criteria:**
- Given an operator in the existing management stock tab, when valid damaged stock is restored, then usable increases, damaged decreases and borrower obligations do not change.
- Given an operator or expired administrator, when write-off is requested directly or from stale UI, then the server forbids it without a ledger event and the UI never substitutes repair silently.
- Given management actions unrelated to restoration, when an operator opens the tab, then those controls remain protected and the permission message accurately scopes the restriction.

## Implementation Notes

The existing `repaired` and `written_off` events and inventory projection were retained. The `/damage` route now admits operator repair but rejects write-off unless the current session is admin. The management card shows operators a fixed repair action, preserves an admin-selected write-off through role loss, and requires explicit re-selection of repair before it can submit. Unrelated management gates remain intact. The obsolete deferred restoration entry was removed.

Independent review added exact admin write-off request-body coverage and an expired-admin operator-repair assertion. The review also identified pre-existing borrower recovery and shared refresh-state concerns, recorded separately in deferred work. Final verification passed: 300 Vitest tests, 24 Playwright browser tests, formatting, ESLint, browser/server type checks, production build, and `git diff --check`. The first parent-run suites were sandbox-blocked from local socket binding (`EPERM`); both passed when rerun with local-listener permission.

## Spec Change Log

## Review Triage Log

| Finding | Verdict and evidence | Route |
| --- | --- | --- |
| Pending save-and-close can dismiss borrower card before truth refresh | high — `operationLocks` permits exit in `refresh-required` with save-and-close, while the card remains mounted and `requestExit` can reset it. This predates this restoration slice. | defer |
| Post-commit borrower truth lock is not durable across reload | medium — the frozen attempt is cleared after commit, whereas refresh/reload recovery lives in React state. A reload loses that particular recovery obligation. This predates this slice. | defer |
| Directory recovery retries can overlap | medium — the buttons remain enabled and the handlers use a stale `operation` closure without checking whether `*-started` was accepted. This predates this slice. | defer |
| Hidden-card reload focus falls to search | low — the startup focus effect handles hidden `refresh-required` but not hidden `reload-required`; the latter recovery control is missed. This predates this slice. | defer |
| Directory recovery lacks progress indication | low — no in-flight affordance accompanies the overlapping-retry behavior; same root cause as the recovery single-flight finding. | grouped with overlap |
| Restoration can be repeated after a committed mutation but failed inventory refresh | medium — the shared `action()` warns but releases `pending` with stale item balances, allowing another non-idempotent submission. The behavior predates operator access and also affects existing admin repairs. | defer |
| Repair form remains enabled with no damaged items | low — the old card behaved this way for admins; adding a conditional empty-state gate is more than a direct correction for an uncommon no-op. | reject |
| Expired admin repair boundary lacks a direct API assertion | low — server role checking makes repair available after downgrade, but the new test checks only rejected write-off at that boundary. | patch test |
| No browser test combines operator management UI and real API | maybe-false — no demonstrated failure; existing API and web tests cover both sides, and a browser case would mainly duplicate those checks. | reject |
| Packaged-desktop save-flow test was not run | false — the save-flow change is in an earlier committed slice, not the current restoration diff; this slice did not change that flow. | reject |
| Browser Back can bypass hidden-card borrower recovery | high — `removeSentinel` is called in hidden-card refresh recovery and browser history can then leave without the component's `requestExit` guard. This predates this slice and shares the borrower truth-lock boundary with the first finding. | defer |
| Admin write-off request body is not asserted | medium — the existing UI test checks the toast and URL but not the now state-derived `resolution`; a wrong request body would pass those checks. | patch test |

## Design Notes

This is the second review slice. The borrower-card/event-model slice may land first, but this permission change should remain inspectable independently. A role downgrade with write-off selected must block rather than silently repair. No migration belongs to this slice.

## Verification

**Commands:**
- `pnpm exec prettier --check .` -- expected: no formatting drift.
- `pnpm lint` -- expected: zero warnings/errors.
- `pnpm typecheck` -- expected: browser/server types pass.
- `pnpm test` -- expected: integration and web regression tests pass.
- `pnpm test:e2e` -- expected: browser workflow remains green.
- `pnpm build` -- expected: production build passes.
- `git diff --check` -- expected: no whitespace defects.
