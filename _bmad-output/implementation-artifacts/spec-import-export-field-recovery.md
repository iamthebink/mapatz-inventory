---
title: 'Import, Export, and Field Recovery'
type: 'feature'
created: '2026-09-05'
status: 'in-progress'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '1f44faf048c07cd590143e741c43acb8cd9e1bba'
context:
  - '{project-root}/_bmad-output/specs/spec-import-export/SPEC.md'
  - '{project-root}/_bmad-output/specs/spec-import-export/workbook-contract.md'
  - '{project-root}/_bmad-output/specs/spec-import-export/stories.yaml'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Mapatz lacks an offline artifact that can support an editable annual reset, invariant-complete disaster recovery, unresolved-damage reporting, and consumables-cycle reporting without moving credentials or application configuration.

**Approach:** Add one centrally contracted XLSX workbook with deliberately disjoint reset and recovery areas, pure parse/validation boundaries, atomic inventory-domain replacement, admin-only server endpoints, and explicit destructive confirmation in the management UI. Implement the five approved stories in order and stop after stories 2 and 3 for the required human checkpoints.

## Boundaries & Constraints

**Always:** Treat the approved SPEC, workbook contract, and story order as canonical. Validate the selected payload completely before mutation. Preserve destination credentials/configuration. Resolve locations solely by unique names and generate numeric IDs. Preserve supplied reset codes (including below 100), generate blank codes at 100+, and require all recovery codes. Reset rebases stock and clears history/state; recovery preserves catalogs, borrowers, chronology, relationships, state, and cycle semantics. Enforce admin authorization at the server.

**Never:** Merge imports, consume the other mode's sheets, transfer secrets/configuration, apply defaults to explicit invalid values, partially commit, add cloud persistence, or weaken ledger/domain invariants.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Export | Mixed active/archived catalogs and event lifecycles | Deterministic workbook areas with accurate reset/recovery payloads and reports | Admin-only; no secrets/configuration |
| Reset | Valid edited reset sheets and explicit confirmation | New catalog and opening stock only; destination credentials unchanged | Full-workbook errors or commit failures roll back |
| Reset invalid | Missing/duplicate/unknown/explicit-invalid values | No mutation; row/sheet/column-aware correction message | Reject atomically |
| Recovery | Complete coherent recovery sheets | Business-state, chronology, relationships, and future operations match source | Reject incomplete/inconsistent payload atomically |
| Cancellation | User declines or request lacks confirmation marker | No import request/mutation | Legible confirmation-required response |

</frozen-after-approval>

## Code Map

- `src/db/migrations/001_initial.sql` and new migration -- current catalog/event/credential schema; retain credentials and ledger immutability while adding unique location names, low item codes, replacement guard, and cycle baseline.
- `src/db/database.ts` -- ordered migration runner and transaction seam.
- `src/domain/inventory.ts` -- existing event-derived state and mutation invariants; extend with typed snapshots and atomic replacement, not XLSX parsing.
- `src/domain/types.ts` -- shared inventory contracts and errors.
- `src/io/workbook-contract.ts` -- new single source of truth for sheet and column names.
- `src/io/workbook.ts` -- new offline ExcelJS serialization/parsing adapter.
- `src/domain/import-export.ts` -- new pure validation/translation and report projections.
- `src/server/index.ts`, `src/server/routes.ts` -- binary limits, admin-only export/reset/recovery endpoints, content headers, and confirmation enforcement.
- `src/web/api.ts`, `src/web/App.tsx` -- binary download/upload helpers and admin management controls with destructive confirmation.
- `tests/domain/*`, `tests/integration/api.test.ts` -- narrow validation/workbook/service tests plus full authorization and rollback workflows using temporary databases/buffers.

## Tasks & Acceptance

**Execution:**
- [x] Story 1 -- add schema/baseline foundation, central workbook contract, exporter, admin server/UI export, and representative deterministic workbook tests.
- [x] Story 2 -- add reset parser/validator, code allocation and location remapping, atomic replacement, confirmed admin server/UI import, adversarial/rollback tests, then checkpoint.
- [ ] Story 3 -- add complete recovery validator/replacement and clean-destination business-equivalence/future-operability tests, then checkpoint.
- [ ] Story 4 -- add unresolved-damage report reconciled to recovery state.
- [ ] Story 5 -- add consumables report with baseline/addition/issue/correction semantics and reset-vs-recovery tests; run all repository gates.

**Acceptance Criteria:**
- Given either import mode, when workbook content is malformed, inconsistent, unauthorized, unconfirmed, cancelled, or fails during commit, then live inventory and destination credentials/configuration are unchanged.
- Given export and clean-destination recovery, when business state is compared, then catalogs, borrowers, events, chronology, relationships, derived loans/damage/loss, baseline, and future operability are equivalent.
- Given reset edits and disjoint recovery edits, when each mode imports, then only its own workbook area determines the result.
- Given mixed inventory, when reports export, then damage reconciles to unresolved recovery state and consumable usage counts issues only while corrections affect remaining.

## Implementation Notes

- 2026-09-05: Legacy data has no inferable original cycle boundary. Migration establishes each existing item's current business quantity as its baseline at upgrade and cuts prior events out of the new reporting cycle; subsequent reset/recovery semantics are exact.
- 2026-09-05: Stories 1-2 use ExcelJS at the adapter edge, exact ordered reset headers, JSON-encoded aliases, binary admin endpoints, and a confirmation header backed by a UI confirmation gate. Atomic replacement opens ledger deletion only through a transaction-scoped database guard and never touches credentials.
- 2026-09-05: Apple Numbers preserves the contracted headers but may add styled trailing blank cells. Header validation now ignores only trailing blank cells while still rejecting missing, reordered, renamed, or additional nonblank columns.

## Spec Change Log

## Review Triage Log

## Design Notes

Keep XLSX concerns at the adapter edge. The domain accepts validated workbook-neutral payloads. Atomic replacement deletes/rebuilds only operational/catalog tables under a transaction-scoped maintenance guard; credentials, migrations, and application configuration are never selected into export or touched by replacement.

## Verification

**Commands:**
- `pnpm test -- <focused files>` -- each story's narrow and integration tests pass before proceeding.
- `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build` -- all final repository gates pass.

**Manual checks:**
- Export as admin and inspect the workbook's fixed sheets/headers; confirm no credential/configuration fields.
- Cancel each import confirmation and verify no request/state change; then import reset/recovery and verify refreshed UI state and continued login.
