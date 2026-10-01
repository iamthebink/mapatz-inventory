---
title: 'Use internal item identity only'
type: 'refactor'
created: '2026-10-01'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: 6b547ae11b99e2b19d28e2f8d6cea48cea0c72c0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Item codes still act as operator-visible identifiers and a second identity system alongside database item IDs. Operators should identify items by their names and aliases; numeric identity is solely internal record keeping.

**Approach:** Remove the separate item code from persistence, domain contracts, and allocation. Use item IDs for internal relationships, remove item identifiers from operator displays/search and operational reports, and use technical item IDs only to connect recovery workbook records. Reset and recovery may allocate fresh IDs.

## Boundaries & Constraints

**Always:** Preserve catalog name uniqueness, aliases, kinds, location associations, balances, archival state, chronology, loan relationships, cycle baselines, credentials, and atomic replacement. Recovery IDs identify records inside the workbook, not a promise of destination identity. Preserve ledger epoch rotation, command receipts, revision checks, and durable identity allocation so pending commands cannot act on replacement records. Keep non-blocking feedback in toasts and blocking decisions in confirmation dialogs.

**Never:** Add compatibility adapters or a new database migration; Or explicitly excluded both. Do not delete or rewrite a local database to make the new schema run. Do not change location codes, borrower usernames, radio numbers, error codes, event identifiers, or unrelated navigation/feedback. Names are presentation and search keys, not replacements for relational item IDs.

**Confirmed decisions:** Eliminate the separate item code; remove it from all operator surfaces, item search, and operational reports; retain technical item IDs only where needed for recovery relationships; reset/recovery may assign fresh IDs. The working tree was cleaned before this work.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|---------------------------|----------------|
| Catalog and desks | Named items with aliases and internal IDs | Display and search names/aliases; no item code or ID columns, badges, copy, or numeric search | Existing toast behavior |
| Reset workbook | Editable catalog rows and stock totals | No item identity column; allocate destination IDs and opening baselines | Reject malformed/duplicate-name rows before mutation |
| Recovery workbook | Items and events/loans linked by technical Item ID | Allocate destination IDs and remap every item reference; preserve business state and future operations | Reject missing, duplicate, invalid, or dangling identity references atomically |
| Old pending action | Command or local attempt predates replacement | Existing epoch/revision checks prevent action on replacement records | Existing stale-state recovery behavior |
| Reports | Damage, consumable usage, period summary, ledger | Items identified by names; no item identifier display or exported report column | Existing authorization and failure feedback |

</frozen-after-approval>

## Code Map

- `src/db/migrations/001_initial.sql`, `002_import_export.sql`, `004_camp_equipment.sql` -- all define/rebuild items; remove code consistently and remove code_sequence.
- `src/db/identity-high-water.ts`, `src/db/operational-state.sql` -- preserve authoritative allocation and operational state.
- `src/domain/types.ts`, `src/domain/inventory.ts` -- remove Item.code, both code allocators, search/order, deletion expectedCode, and code projections. Change isItemReceiptFor's code-based discriminator to kind/name.
- `src/contracts/period-summary.ts`, `src/server/routes.ts` -- remove period item code and deletion expectedCode; retain other confirmation checks.
- `src/domain/import-export.ts` -- replace recovery code keys with id/itemId, remove nextItemCode, and preserve validation/remapping. Reset rows need no identity. Event IDs may remain unchanged.
- `src/io/workbook-contract.ts`, `src/io/workbook.ts` -- remove reset/report identifier columns; rename recovery keys Item ID; remove Next Item Code metadata.
- `src/web/InventoryManagement.tsx`, `ConsumablesDesk.tsx`, `BorrowerWorkflow.tsx`, `App.tsx`, `PeriodSummary.tsx`, `borrower-workflow-state.ts` -- remove item code display/search/validation; retain internal ID validation.
- `tests/domain`, `tests/integration`, `tests/web`, `tests/e2e/borrower-workflow.spec.ts` -- adapt fixtures and protect identity safety and business equivalence.
- `sample_data/mapatz-full-recovery-sample.xlsx`, `README.md`, `_bmad-output/specs/spec-import-export/workbook-contract.md` -- update shipped sample/current documentation; completed historical specs remain historical.

## Tasks & Acceptance

**Execution:**
- [x] Schema, domain, contracts, routes above -- remove the second identity system; use names for ordering/search and IDs for relationships.
- [x] Transfer/workbook files above -- remove reset identity, remap recovery identity, remove code cursors and report columns.
- [x] Web files above -- remove identifier presentation/search without weakening staged-state validation.
- [x] Test paths above -- cover remapping, future return/issue operations, invalid recovery rollback, and stale-command rejection.
- [x] Sample/documentation paths above -- align shipped artifacts with the new contract.

**Acceptance Criteria:**
- Given a newly initialized database, when items are created and deleted, then only internal item IDs are allocated, no item-code column/sequence exists, and deleted IDs cannot be reused by pending commands.
- Given recovery into a populated destination, when fresh item IDs differ from the workbook IDs, then loans, events, baselines, reports, and subsequent operations remain business-equivalent.
- Given operator inventory, borrower, consumable, summary, and ledger flows, when items are rendered or searched, then names/aliases provide identification and internal item numbers are absent.

## Implementation Notes

- Removed item code storage/allocation and API fields; names/aliases now identify operator-facing items. Location/error codes remain unchanged.
- Recovery uses workbook-local item IDs and allocates fresh destination IDs while preserving event IDs, relationships, state, cycle baselines, and epoch/high-water protection. Reset and operational report sheets have no item identifier columns.
- Updated the shipped 72-item sample workbook and current contract documentation. Existing local databases were untouched; no migration or compatibility adapter was added.
- Matrix audit: inventory schema/search and management UI tests cover identity removal; workbook/reset/report tests cover exact headers and totals; recovery tests cover remapping, future operations and atomic invalid-ID rejection; existing borrower-operation and management tests cover stale epochs and durable deletion identity.
- Verification: 438/438 regression tests and 37/37 browser tests passed; client/server typecheck, lint, repository formatting, production build and diff checks passed. pnpm registry signature bootstrap failed; checks used installed local binaries, and browser tests used a temporary launcher override with unchanged test/project settings. One browser timing failure passed in isolation and on the complete rerun.

## Spec Change Log

## Review Triage Log

| Finding | Verdict | Evidence and route |
| --- | --- | --- |
| Blind 1: old schema opens but cannot create items | false | Existing-database support is explicitly excluded by Or's no-compatibility/no-migration decision. README instructs separate fresh initialization, and existing databases were preserved; this is an unsupported upgrade rather than a defect in the approved fresh schema. |
| Blind 2: separation test edits obsolete reset column | medium | Total moved to column 7 and exported rows sort by name; the old edit tests neither Water nor Total. Patch the named row/header and compare full recovery data. |
| Blind 3: report arrayContaining permits extra rows | low | New weaker matcher accepts duplicate reports; restore exact sorted arrays as a direct test correction. Patch. |
| Blind 4: reset report expectations omit item identity | low | Without itemName, swapped quantities could pass; include names in complete expected rows. Patch with Blind 3. |
| Blind 5: comparison helper masks duplicate IDs | false | Recovered snapshots read SQLite items with a primary-key constraint; incoming payloads pass duplicate/positive-ID validation before mutation. The helper resolves all event/loan references by name and throws on dangling IDs. Duplicate recovered IDs cannot occur in these callers. |
| Blind 6: additional invalid-XLSX endpoint matrix | low | Current workbook tests cover missing IDs and full valid column/reference mapping; domain mutation tests cover duplicate/dangling IDs atomically, and integration tests exercise rejected imports. Additional malformed transport combinations would add coverage, but no wrong current behavior was demonstrated; reject the broader matrix. |
| Blind 7: ID exclusion tested only in management | low | Independent desk search implementations lack negative numeric-search assertions; patch their existing tests. Summary/report exact contracts already omit code, ledger source renders/searches names, and no numeric-display bug was found. |
| Blind 8: README event vocabulary omits damaged found return | low | The omission exists in the baseline README; identity changes preserve event kinds. Defer this pre-existing documentation inconsistency. |
| Blind 9: current contract omits camp equipment Kind | low | Newly tracked contract lists only two kinds while parser accepts three. Direct documentation correction. Patch. |
| Blind 10: current contract claims replay-derived balances | low | Domain validates authoritative item/loan state separately from audit quantities; independently edited audit regression proves no reconstruction. Correct newly tracked contract prose. Patch. |
| Verification 1: reset separation test no longer exercises edit | medium | Pre-verified obsolete-column/wrong-row gap duplicates Blind 2; same patch. |
| Verification 2: desk numeric-search exclusions untested | low | Pre-verified gap duplicates the independent desk portion of Blind 7; same test patch. |
| Edge review | — | No findings. |

## Verification

Final post-review run: 438/438 regression tests and 37/37 Chromium browser tests passed. Both TypeScript targets, ESLint, Prettier, production build, and diff checks passed using installed local binaries. All review patches were inspected; no unresolved runtime defect was demonstrated. One pre-existing README vocabulary omission is recorded in deferred-work.md.

- `pnpm format:check`, `pnpm lint`, `pnpm typecheck` -- all pass.
- `pnpm test`, `pnpm test:e2e`, `pnpm build` -- regression suite, browser workflow tests, and production build pass.
- Inspect final item-code references to distinguish removed identities from intentionally retained location/error codes; inspect workbook headers and fresh database schema.
