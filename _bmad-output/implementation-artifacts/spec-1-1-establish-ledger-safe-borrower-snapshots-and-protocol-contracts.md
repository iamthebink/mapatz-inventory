---
title: 'Establish Ledger-Safe Borrower Snapshots and Protocol Contracts'
type: 'feature'
created: '2026-09-08'
status: done
baseline_revision: 4b5429c1b16d06deeae48d0c5f8079938ffa0b10
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '_bmad-output/implementation-artifacts/epic-1-context.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** The borrower-centered desk flow lacks a browser-safe protocol, a ledger generation boundary, and authoritative search/card snapshots. Existing list endpoints can expose separately read projections and cannot prevent obsolete future commands from crossing a reset or recovery.

**Approach:** Add the shared version-1 contracts, migration-backed ledger epoch and receipt foundation, epoch rotation during replacement, and transactionally consistent borrower search and desk-snapshot GET surfaces. Keep this slice independently reviewable and free of command or React workflow behavior.

## Boundaries & Constraints

**Always:** Keep normalization and composite snapshot truth in `InventoryService`; use one read transaction per public snapshot and a reusable in-transaction assembler; preserve the append-only event schema and existing authorization/error envelope; return deterministic, browser-safe data with lowercase wire codes. Migration 005 may add only receipts, the epoch column, and the two approved indexes. Reset/recovery must rotate epoch and clear receipts inside their existing replacement transaction, while workbook data excludes both. Raise the supported Node floor to 22.16. Follow-up review requires `spawn_agent` availability and capacity to launch four reviewer subagents concurrently in one simultaneous batch. Because the coordinator also occupies a thread, the repository-local `.codex/config.toml` must set `[agents].max_concurrent_threads_per_session` to at least `5` before re-drive.

**Never:** Add transaction/batch/group entities or event fields, receipt-to-event relationships, borrow/return commands, staged state, production React changes, Playwright setup, draft persistence, netting, dialog work, or unrelated refactors. Do not modify the frozen planning baseline or orchestrator-owned `sprint-status.yaml`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Migrate v4 database | Existing domain rows, guard, baselines, and ledger | Version 5 adds exact approved schema; epoch starts at 1; projections and FKs remain intact; rerunning the runner is a no-op | Partial migration rolls back without masking the original failure; `db.isTransaction` is false afterward |
| Successful replacement | Annual reset or full recovery with prior receipts | Epoch increments once and receipts clear in the same transaction; export/recovery payload remains unchanged | No partial replacement state is visible |
| Failed replacement | Failure after replacement work begins | Previous epoch, receipts, guard, borrowers, stock, and ledger all remain unchanged | Existing typed failure propagates after rollback |
| Borrower search | Normalized query across active and archived borrowers | Active name/username/contact substring matches are deterministically ordered; exact archived username/contact/full-name matches are separate with `matchedBy`; response includes epoch | Empty query never manufactures archived blank-contact matches; DB failures use `{error,message}` rather than a successful empty result |
| Desk snapshot | Active borrower with returned, damaged, lost, and archived-item history | One response contains borrower, every code-ordered non-consumable, selectable flags, aggregated returnable/lost facets including lost-only rows, global watermark, and epoch | Unknown/inactive borrower uses the existing typed error envelope; no fabricated snapshot |
| Existing forbidden mutation | Unauthorized admin-only request after migration | Existing 403 behavior remains and no event or receipt is written | Existing error code/message contract is preserved |

</intent-contract>

## Code Map

- `src/contracts/borrower-workflow.ts` -- new browser-safe version-1 request, snapshot, conflict, result, validation, and protocol-error discriminated unions; type-only reuse of `Borrower`/`Item` from `src/domain/types.ts` is safe.
- `src/db/migrations/005_idempotency.sql` -- add exact `idempotency_receipts` schema/checks, `inventory_replacement_guard.ledger_epoch DEFAULT 1`, and indexes on `(related_event_id, kind)` and `(borrower_id, item_id, kind, created_at, id)`; do not alter `inventory_events`.
- `src/db/database.ts:18` -- register migration 005 without disabling foreign keys; retain the runner's guarded rollback through `DatabaseSync.isTransaction`.
- `src/domain/inventory.ts:14` -- reuse projection SQL; add shared text normalization, epoch access, search snapshot, and desk snapshot in `InventoryService`. `listLoans` at line 275 contains the checkout returnable/lost arithmetic, while item/borrower mappers at lines 417-441 are reuse points.
- `src/domain/import-export.ts:352` -- snapshot exports only domain rows; rotate epoch/delete receipts inside both `replaceWithReset` and `replaceWithRecovery` transactions before replacement writes.
- `src/server/routes.ts:140` -- add public `GET /borrowers/search?q=` and `GET /borrowers/:id/desk-snapshot`; construct responses with static compatibility against shared contracts and let failures reach the existing envelope.
- `src/server/index.ts:55` -- read-only evidence: canonical `{error,message}` mapping; do not add a parallel snapshot error format.
- `package.json`, `README.md:20` -- change the declared supported Node floor from 22.12 to 22.16; update `pnpm-lock.yaml` only through normal package-manager metadata generation if it actually records the root change. `Dockerfile` already uses Node 24.
- `tests/domain/borrower-workflow-foundation.test.ts` -- focused migration, normalization/search, snapshot consistency, ledger-shape, and rollback coverage.
- `tests/domain/recovery.test.ts`, `tests/domain/workbook.test.ts` -- extend existing recovery/reset success and forced-rollback fixtures with epoch/receipt invariants and export exclusion.
- `tests/integration/borrower-workflow-api.test.ts` -- exact GET transport, ordering, typed-failure, and authorization-regression coverage.
- `src/web/**`, `_bmad-output/implementation-artifacts/sprint-status.yaml` -- explicit read-only boundaries for this story.

## Tasks & Acceptance

**Execution:**
- [x] `src/contracts/borrower-workflow.ts` -- define the architecture-approved snapshot and future command protocol contracts with literal `contractVersion: 1`, stable lowercase discriminants, positive-ID/count semantics, and no server-only runtime imports -- establish one statically checked browser/server vocabulary before routes ship.
- [x] `src/db/migrations/005_idempotency.sql`, `src/db/database.ts` -- implement and register the exact additive migration -- establish durable epoch/receipt infrastructure without changing ledger meaning.
- [x] `src/domain/inventory.ts` -- centralize normalization as Unicode NFKC, trimmed/collapsed whitespace, and locale-independent lowercase; implement deterministic search plus public read-transaction/private in-transaction desk snapshot assembly -- keep later command reuse compatible with one-write-transaction ownership.
- [x] `src/domain/import-export.ts` -- increment the singleton epoch and delete receipts within both existing replacement transactions, excluding local protocol state from transfer snapshots -- make reset/recovery a real command-obsolescence boundary.
- [x] `src/server/routes.ts` -- expose both GET endpoints and statically bind response construction to shared contracts -- preserve standard transport and error behavior.
- [x] `package.json`, `README.md`, `pnpm-lock.yaml` -- align the supported runtime floor to Node 22.16 without adding Story 1.6 dependencies -- make `isTransaction` support truthful.
- [x] `tests/domain/borrower-workflow-foundation.test.ts`, `tests/domain/recovery.test.ts`, `tests/domain/workbook.test.ts`, `tests/integration/borrower-workflow-api.test.ts` -- protect every matrix row, including migration idempotency/rollback, exact schema, normalization/order, lost-only and archived-item projections, consistent watermark/epoch, replacement atomicity, typed GET failures, and unchanged mutation authorization.

**Acceptance Criteria:**
- Given a populated version-4 database, when the application migrates it and the migration runner is invoked again, then schema version 5 contains only the approved receipt table, epoch column, and two indexes; epoch is 1; `PRAGMA foreign_key_check` is clean; pre-existing projections are identical; and `inventory_events` has no batch/group/transaction/receipt field.
- Given migration SQL fails after beginning, when the runner handles the error, then all version-5 DDL is absent, prior data and guard state remain intact, and the connection is outside a transaction.
- Given successful and forced-failure annual reset/full recovery operations, when persisted state is inspected, then success increments epoch once and clears receipts without exporting them, while failure preserves the prior epoch, receipts, borrowers, inventory, events, and guard atomically.
- Given active and archived borrowers with normalization collisions, when `GET /api/borrowers/search?q=...` is called, then the exact `BorrowerSearchSnapshot` includes the current epoch, stable active-first ordering across name/username/contact substrings, and only separately classified exact archived matches with deterministic username-before-contact-before-full-name precedence.
- Given an active borrower with multiple checkouts, usable/damaged returns, mark/unmark-loss events, a lost-only holding, archived referenced items, consumables, and camp equipment, when `GET /api/borrowers/:id/desk-snapshot` is called, then the response is one internally consistent `BorrowerDeskSnapshot`: all and only non-consumables ordered by code, archived entries non-selectable, holdings aggregated per item with returnable and lost facets, lost-only rows retained, and `asOfEventId` equal to the global event maximum while serving only as diagnostics.
- Given unknown/inactive borrower IDs or an internal snapshot failure, when either GET surface cannot produce authoritative truth, then it returns the existing typed `{error,message}` failure envelope and never `200` with empty fabricated state.
- Given browser and server type-checking, when shared contracts and route response builders compile, then request/result/error unions remain discriminated by stable lowercase codes and introduce no Node-only/server-only dependency into the browser graph.
- Given existing role behavior after migration, when an unauthorized admin mutation is attempted, then its status/envelope are unchanged and event/receipt counts do not change.
- Given the completed story, when verification runs, then formatting, lint, type checking, focused tests, the full suite, and production build pass with no production React or orchestrator-state diff.

## Spec Change Log

## Review Triage Log

### 2026-09-08 — Review pass
- verdicts: 22 findings — high 5, medium 9, low 5, false 3, maybe-false 0
- findings:
  - `[false]` `[reject]` `CommandProtocolError` omits `invalid_json` — the shared union exactly follows the adopted command-protocol contract and is not the generic Express transport envelope; `invalid_json` remains handled by the existing `ApiError` path, so omission does not create the claimed exhaustive-union guarantee.
  - `[medium]` `[patch]` The private desk-snapshot assembler rejected inactive borrowers needed by later same-transaction conflict snapshots — active validation now lives in the public GET-facing method while the private assembler loads archived identity.
  - `[low]` `[patch]` Request types duplicated the literal contract version — both now derive it from `typeof BORROWER_WORKFLOW_CONTRACT_VERSION`.
  - `[medium]` `[patch]` `readTransaction` accepted promise-returning callbacks and could commit before asynchronous completion — its generic signature now rejects `PromiseLike` return types at compile time.
  - `[low]` `[reject]` Desk inventory mapping performs one alias query per item — the synchronous local-SQLite path is real but not shown to violate a user-visible bound, and batching aliases would add nontrivial query/mapping complexity outside the smallest foundation change.
  - `[medium]` `[patch]` Migration tests asserted receipt column names but not exact metadata — coverage now verifies type, nullability, primary-key status, defaults, checks, and epoch metadata.
  - `[medium]` `[patch]` Migration tests asserted index names but not column order — coverage now verifies both approved index sequences through `pragma_index_info`.
  - `[medium]` `[patch]` Search fixtures accidentally matched insertion order — fixtures now reverse the expected order and exercise normalized name, username, ID, and archived match-class tie-breaks.
  - `[medium]` `[patch]` Desk holdings coverage used only one checkout per item — the fixture now aggregates split returns and losses across multiple same-item checkouts.
  - `[high]` `[patch]` Snapshot consistency was not distinguished from untransactional sequential reads — deterministic file-backed two-connection tests now interleave committed writers and prove search and desk snapshots remain on one generation.
  - `[low]` `[patch]` Only search had an injected internal API failure — desk-snapshot projection failure now verifies the same 500 envelope and transaction cleanup.
  - `[high]` `[patch]` SQLite permits multiple NULL values in a non-integer `TEXT PRIMARY KEY` — migration 005 now declares receipt keys explicitly `NOT NULL`, with a rejecting test.
  - `[low]` `[reject]` Repeated or structured `q` values are coerced rather than rejected — the story defines normalized search semantics, not a query-cardinality protocol; the uncommon malformed request has negligible impact and adding a new validation branch is not justified here.
  - `[high]` `[patch]` Replacement could proceed when the singleton guard row was absent — reset/recovery now require the epoch update to affect exactly one row and roll back with `internal_error` otherwise.
  - `[low]` `[reject]` Epoch precision can eventually exceed JavaScript's safe integer range — reaching that state requires quadrillions of successful replacements, while a guard would introduce an unspecified exhaustion policy for no practical user benefit.
  - `[false]` `[reject]` Shared contracts do not statically constrain positive IDs/counts — the adopted browser-safe contract intentionally represents these as `number`; runtime schemas own numeric validation in later command work, so branded-number enforcement is not a missing invariant here.
  - `[high]` `[patch]` Read-transaction isolation lacked an exercised regression boundary — the new two-connection search and replacement-interleaving tests fail if the public read transaction is removed.
  - `[high]` `[patch]` Successive replacements did not prove monotonic epoch rotation — reset and recovery tests now perform a second successful replacement and assert epoch 3.
  - `[medium]` `[patch]` Active username-only search was unverified — the API suite now asserts a borrower matched only through a username substring.
  - `[medium]` `[patch]` Search-order tests agreed with database insertion order — reversed and tied fixtures now make removal of either explicit sort observable.
  - `[medium]` `[patch]` Nonzero damaged inventory was calculated but not asserted — domain and API snapshot tests now retain and verify the damaged balance.
  - `[false]` `[reject]` The diff could be read as missing runtime command/idempotency behavior — the named Story 1.1 artifact unambiguously defines the foundation/read-boundary slice and explicitly leaves command execution to Story 1.2; the reviewed diff aligns with that surface and preserves `sprint-status.yaml`.

### 2026-09-08 — Review pass
- verdicts: 10 findings — high 0, medium 1, low 3, false 6, maybe-false 0
- findings:
  - `[false]` `[reject]` The baseline excludes the implementation commit from this resumed run's diff — `baseline_revision` correctly captures the current `HEAD` required by the workflow; revision `4b5429c1b16d06deeae48d0c5f8079938ffa0b10` already contains the implementation and the existing triage log records its review, so unchanged implementation is not an unreviewed outcome of this resumed delta.
  - `[medium]` `[reject]` The spec does not reproduce every exact receipt-schema and protocol-contract definition from the Architecture Spine — the claimed derivation weakness is real, but its proposed remedy edits this build's spec, which review routing explicitly rejects; the implemented schema and contracts are present, focused tests verify their exact shape, and the full verification passed.
  - `[low]` `[reject]` The acceptance text does not explicitly say an empty normalized query returns two empty result arrays — the implementation and focused regression test enforce exactly that behavior, while correcting the documentation would edit this build's spec and provides no runtime benefit in this completed slice.
  - `[low]` `[reject]` The acceptance text says ordering is deterministic without spelling out every sort key — the implementation and focused tests pin normalized name, username, ID, and archived match-kind precedence; the proposed documentation-only correction edits this build's spec.
  - `[false]` `[reject]` Verification contains expected outcomes but no completed evidence — `## Verification` is the plan by design; this run records the executed commands and outcomes under `## Auto Run Result` during finalization.
  - `[false]` `[reject]` The protected-path command alone cannot prove committed implementation paths were untouched — the workflow additionally inspects the complete baseline diff, and revision `4b5429c1b16d06deeae48d0c5f8079938ffa0b10` changes neither `src/web` nor `sprint-status.yaml`; the command correctly checks the resumed working delta.
  - `[low]` `[reject]` The Code Map has a stale `listLoans` line number and omits the small `tests/domain/inventory.test.ts` fixture adjustment — both observations are accurate but documentation-only, do not obscure the named symbol or executable coverage, and their fix would edit this build's spec.
  - `[false]` `[reject]` `review_loop_iteration: 0` conflicts with an earlier review pass and the empty Spec Change Log — the counter increments only for `bad_spec` loopbacks, and Spec Change Log entries are likewise required for spec amendments; the recorded prior pass applied code patches without a bad-spec loop.
  - `[false]` `[reject]` The concurrency requirement introduces an unlisted `.codex/config.toml` mutation — the setting predates revision `4b5429c1b16d06deeae48d0c5f8079938ffa0b10`, no config mutation exists in the story commit, and the current value is `8`, satisfying the explicit orchestration prerequisite.
  - `[false]` `[reject]` The review diff implements only a documentation artifact rather than the executable intent — this is a resumed delta from current `HEAD`; the executable contracts, migration, domain logic, routes, runtime metadata, and tests are already present in revision `4b5429c1b16d06deeae48d0c5f8079938ffa0b10`, were independently inspected, and passed all required verification.

## Design Notes

The snapshot API should have a public transaction wrapper and a private assembler that assumes an existing transaction. This prevents torn reads today without forcing Story 1.2 into a nested transaction when conflict results need the same snapshot. Active search ordering and archived `matchedBy` precedence are deliberately deterministic; `asOfEventId` remains observational, not a lock token.

## Verification

**Commands:**
- `pnpm exec vitest run tests/domain/borrower-workflow-foundation.test.ts tests/domain/recovery.test.ts tests/domain/workbook.test.ts tests/integration/borrower-workflow-api.test.ts` -- expected: focused migration, replacement, snapshot, and API tests pass.
- `pnpm exec prettier --check .` -- expected: no formatting drift.
- `pnpm lint` -- expected: zero warnings/errors.
- `pnpm typecheck` -- expected: browser and server contracts compile.
- `pnpm test` -- expected: complete suite passes.
- `pnpm build` -- expected: production server and web bundles succeed.
- `git diff --exit-code -- src/web _bmad-output/implementation-artifacts/sprint-status.yaml` -- expected: excluded production UI and orchestrator state remain unchanged.

## Auto Run Result

Status: done

### Summary

The ledger-safe borrower workflow foundation is complete. Revision `4b5429c1b16d06deeae48d0c5f8079938ffa0b10` provides the browser-safe version-1 contracts, migration-backed ledger epoch and idempotency receipt foundation, atomic epoch rotation during reset/recovery, transactionally consistent borrower search and desk snapshots, public GET routes, Node 22.16 floor, and regression coverage. This resumed run found no unfinished implementation work.

### Files Changed

- `src/contracts/borrower-workflow.ts` — defines the shared version-1 browser/server protocol vocabulary.
- `src/db/migrations/005_idempotency.sql` and `src/db/database.ts` — add and register ledger epoch, receipts, and approved indexes.
- `src/domain/inventory.ts` — implements normalization, deterministic search, and transactionally consistent desk snapshots.
- `src/domain/import-export.ts` — rotates epochs and clears receipts atomically during replacement.
- `src/server/routes.ts` — exposes borrower search and desk-snapshot GET surfaces.
- `package.json` and `README.md` — declare the Node 22.16 runtime floor.
- `tests/domain/borrower-workflow-foundation.test.ts`, `tests/domain/inventory.test.ts`, `tests/domain/recovery.test.ts`, `tests/domain/workbook.test.ts`, and `tests/integration/borrower-workflow-api.test.ts` — cover schema, transactions, normalization, ordering, snapshot truth, recovery/reset, errors, and authorization.
- `_bmad-output/implementation-artifacts/spec-1-1-establish-ledger-safe-borrower-snapshots-and-protocol-contracts.md` — records final review and verification evidence.

### Review Findings

No patches were required and no items were deferred. One medium and three low documentation findings were rejected because their only fix would edit the build spec after the implementation and executable tests had already fixed the behavior. Six findings were rejected as false: the current-head baseline and resumed-delta semantics are correct; final verification evidence belongs here; protected paths were checked across the actual implementation revision; the review-loop counter is not a review-pass counter; the agent concurrency setting predates the story commit; and the executable implementation is present in the baseline revision. The full reasons are recorded in the 2026-09-08 triage entry above.

Follow-up review recommended: false. Patched entries this pass: high 0, medium 0, low 0.

### Verification Performed

- Focused Vitest suite: 4 files, 26 tests passed.
- Prettier check: passed with no formatting drift.
- ESLint: passed with zero warnings or errors.
- TypeScript client and server type checks: passed.
- Full Vitest suite: 13 files, 92 tests passed.
- Production server and Vite web build: passed.
- `src/web` and `_bmad-output/implementation-artifacts/sprint-status.yaml` working-delta check: clean.
- Matrix audit: every I/O and edge-case row is covered by an executed focused test.

### Residual Risks

No known functional residual risk remains for Story 1.1. Runtime borrow/return command execution and UI workflow behavior remain intentionally deferred to later stories by the intent contract.
