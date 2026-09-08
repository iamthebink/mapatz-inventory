---
title: 'Commit Borrower Operations and Creation Atomically'
type: 'feature'
created: '2026-09-08'
status: 'done'
baseline_revision: eb49342eeaa7b77cc8d19bc52aa476f8cf4c62c9
baseline_commit: eb49342eeaa7b77cc8d19bc52aa476f8cf4c62c9
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '_bmad-output/implementation-artifacts/epic-1-context.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** The borrower desk protocol has durable receipt and epoch foundations, but borrower creation and inventory mutations still execute as independent legacy operations. A retry, stale snapshot, validation race, or mid-command failure can therefore duplicate or partially apply operator intent.

**Approach:** Add strict versioned POST commands whose domain services own one SQLite transaction covering epoch validation, receipt handling, current-state validation, deterministic return allocation, ordinary ledger appends or borrower insertion, and the final receipt. Preserve significant request order, return fresh same-boundary conflict truth, and adapt only the existing borrower-creation caller needed to keep production behavior valid.

## Boundaries & Constraints

**Always:** Require a UUID idempotency key, contract version 1, and the current positive ledger epoch; validate transport before domain access and compare epoch before receipt lookup. Bind receipt identity to command kind, route subject, epoch, version, and the schema-normalized request while preserving item and part array order. Each public command opens exactly one transaction. Process item groups by item ID, persisted checkouts by `created_at` then event ID, return parts in request order, usable before damaged, all returns before borrows, and never allocate a return to a checkout created by the same command. Persist only `committed` or `rejected` receipt markers, inserting the receipt last. Replays of committed requests return the original result without mutation; rejected replays recompute current validation without mutation. Preserve current operator/admin permissions and place authorization before parsing/domain work. Use existing typed protocol/result unions and ordinary ungrouped ledger events.

**Never:** Add transaction, batch, or receipt fields to `inventory_events`; add grouped history or rollback semantics; persist staged UI state; cache stale rejection reasons; net borrow and return directions; call transaction-owning legacy mutation methods from inside a command; make these operator operations admin-only; broaden UI workflow work beyond the minimal borrower-create transport adaptation; modify the frozen planning baseline or `_bmad-output/implementation-artifacts/sprint-status.yaml`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Mixed commit | Active borrower; valid repeated return and borrow parts across unsorted item groups | One transaction appends allocated usable/damaged returns, then checkouts, in deterministic order; source notes and checkout relations are preserved | Any append or receipt failure rolls back every event and receipt |
| State conflict | Inactive borrower, invalid item, stale returnable balance, or insufficient stock | No events; one rejected receipt; ordered conflicts and a fresh desk snapshot come from the same write boundary | Return receipt-backed `409`; borrower conflict suppresses item conflicts, item prerequisites suppress direction conflicts, invalid return suppresses same-item borrow conflict |
| Committed retry | Same key and canonical request | Original result is returned with `replayed: true`; no row or event is duplicated | A changed body, subject, kind, version, or epoch for the key returns `idempotency_key_reused` without mutation |
| Rejected retry | Same rejected key after state remains conflicting or becomes valid | Recompute and return `conflicted` or `now_valid`; never apply the old request | Return receipt-backed `409`; caller needs a new key to commit |
| Stale epoch | Request epoch differs from the singleton epoch, including when an old receipt remains | Reject before receipt lookup or domain validation | Return `ledger_epoch_changed`; no mutation |
| Atomic create | Valid normalized fields and no exact normalized identity collisions | Insert one borrower and final receipt; replay returns the originally stored borrower | Exact active or archived matches return deterministic field errors/matches and a rejected receipt; receipt failure rolls back borrower insertion |
| Invalid transport | Missing/non-UUID key, wrong version, unsafe IDs/counts, empty/duplicate groups, zero return, overlong note, or unknown field | Domain service is not called and no receipt is written | Return `400 validation_error` with ordered field errors and no echoed idempotency key |
| Unknown borrower | Positive route ID has no borrower | No snapshot is fabricated and no receipt is written | Preserve existing `404 {error,message}` behavior because the adopted conflict union has no `borrower_not_found` case |

</intent-contract>

## Code Map

- `src/contracts/borrower-workflow.ts` -- existing version-1 request, conflict, validation, protocol-error, and result unions; add replay identity to committed borrower creation so both command retries are observable.
- `src/db/migrations/005_idempotency.sql` -- read-only receipt contract: key, command kind, epoch, version, canonical hash, outcome, optional subject, and result JSON; no migration or ledger-schema change belongs here.
- `src/db/database.ts:58` -- `transaction()` supplies the single `BEGIN IMMEDIATE` ownership boundary and rollback cleanup.
- `src/domain/inventory.ts:25` -- reuse `normalizeBorrowerText`; `createBorrower` at line 135 and `checkout`/`returnCheckout` at lines 264-318 are legacy transaction-owning APIs, not nested-command reuse points. Add atomic command entry points plus private validation, canonical receipt, allocation, and append helpers. Reuse `append` at line 380, `ledgerEpochInTransaction` at line 428, and `borrowerDeskSnapshotInTransaction` at line 437.
- `src/server/routes.ts:24` -- keep ordinary legacy schemas separate; add strict nested command schemas, UUID header parsing, authorization-before-validation, exact status mapping, `POST /borrowers/:id/operations`, and route `POST /borrowers` through atomic creation.
- `src/server/index.ts:55` -- preserve generic `{error,message}` handling; command routes must return their richer validation/protocol/result bodies without globally changing unrelated errors.
- `src/server/session.ts` -- read-only permission evidence: the runtime has only operator/admin roles and expiration downgrades admin to operator; preserve operator access rather than inventing an unreachable guest policy.
- `src/web/App.tsx:1266` -- minimally adapt the existing create-borrower POST to obtain/use the current epoch and send `Idempotency-Key`, without implementing Story 1.3 frozen-attempt persistence or workflow state.
- `tests/domain/borrower-operation.test.ts` -- new focused command tests for allocation order, conflict precedence, exact one-transaction ownership, rollback, canonical identity, both replay modes, epoch-first behavior, and normalized creation conflicts.
- `tests/integration/borrower-workflow-api.test.ts` -- extend exact POST validation, status/envelope, replay, mismatch, authorization-order, and no-mutation transport coverage.
- `_bmad-output/implementation-artifacts/sprint-status.yaml`, `_bmad-output/planning-artifacts/**` -- explicit read-only boundaries.

## Tasks & Acceptance

**Execution:**
- [x] `src/contracts/borrower-workflow.ts` -- make committed creation results identify first execution versus replay -- keep retry behavior explicit and statically checked.
- [x] `src/domain/inventory.ts` -- implement both receipt-backed commands and private deterministic validation/allocation helpers under one transaction each -- make command success, rejection, replay, and failure atomic without changing ledger meaning.
- [x] `src/server/routes.ts` -- add strict command validation, key parsing, authorization ordering, operation routing, and exact HTTP result mapping; replace legacy borrower-create transport with the versioned command -- reject malformed requests before persistent access.
- [x] `src/web/App.tsx` -- send the required epoch/version/key for the existing creation action -- keep the current production UI functional while deferring the full workflow controller.
- [x] `tests/domain/borrower-operation.test.ts`, `tests/integration/borrower-workflow-api.test.ts` -- cover every matrix row, schema nesting, event order and relations, same-boundary snapshots, receipt identity, forced rollback, and unchanged permissions -- protect the protocol and ledger invariants at domain and outer HTTP surfaces.

**Acceptance Criteria:**
- Given a valid mixed operation with multiple persisted checkouts and repeated parts, when it commits, then exactly one transaction appends ordinary events in item-ID order with every return part allocated usable-before-damaged across checkouts ordered by creation time then ID, all returns preceding all borrows, source notes retained, no new checkout used as a return target, and one final committed receipt.
- Given any current-state conflict, when the operation is submitted, then no inventory event is appended, conflicts follow borrower/item/direction precedence and deterministic ordering, and the `409` result contains a fresh borrower snapshot assembled inside the same transaction as the rejected receipt.
- Given an identical committed key is retried for either command, when the server handles it, then it returns `201` with the original result and `replayed: true` without duplicating events or borrowers; any identity mismatch returns `409 idempotency_key_reused` without mutation.
- Given an identical rejected key is retried after state changes, when validation reruns, then the response reports current `conflicted` or `now_valid` truth without applying the request or rewriting historical rejection reasons.
- Given a stale/future ledger epoch, when either command is submitted, then `ledger_epoch_changed` wins before receipt lookup and no borrower, event, or receipt changes.
- Given exact normalized borrower identity collisions, when creation is submitted, then deterministic field errors and active/archived matches use the shared normalization and match precedence; otherwise borrower insertion and receipt commit atomically, and failure of either rolls both back.
- Given malformed command transport or unauthorized route state, when the request arrives, then authorization and strict validation fail before domain/receipt access, response bodies follow the shared protocol without exposing a key before receipt processing, and existing operator access remains unchanged.
- Given the completed story, when verification runs, then focused and full tests, formatting, lint, type checking, production build, direct ledger/receipt inspection, and protected-path diffs pass.

## Spec Change Log

## Review Triage Log

### 2026-09-08 — Review pass
- verdicts: 23 findings — high 0, medium 13, low 3, false 7, maybe-false 0
- findings:
  - `[medium]` `[patch]` Individually safe quantities could overflow aggregate borrow/return totals — transport validation now rejects unsafe per-part, per-item, and whole-command aggregates, with an HTTP regression.
  - `[medium]` `[patch]` One borrower matching multiple creation fields produced only the precedence-selected field error — collision collection now records every independently matched field while retaining one deterministic `matchedBy` row.
  - `[low]` `[patch]` Unknown object keys were reported with an empty field path — Zod `unrecognized_keys` issues now expand to concrete top-level and nested paths.
  - `[false]` `[reject]` Command notes should reject line breaks — existing note editors are textareas and the ledger/recovery contract permits arbitrary text up to 500 characters; no single-line invariant exists.
  - `[low]` `[reject]` `crypto.randomUUID()` could fail on plain-HTTP LAN access — the documented production surface is `http://localhost`, which is a trustworthy context; adding a fallback for an unsupported deployment would add complexity without an everyday defect.
  - `[false]` `[reject]` Malformed committed receipt JSON can produce an invalid operation replay — every application producer writes the typed committed result atomically and no import/recovery path admits receipts; manual database corruption is not a reachable application state and already fails loudly when JSON is malformed.
  - `[low]` `[patch]` Return allocation tests did not cross a checkout boundary within one part — the focused test now fragments one usable part across two persisted checkout IDs and verifies relation and note preservation.
  - `[medium]` `[patch]` Rejected borrower-creation replay lacked conflicted and now-valid coverage — focused tests now prove fresh validation, no insertion, and an unchanged single receipt in both states.
  - `[medium]` `[patch]` HTTP tests covered only successful command statuses — integration coverage now verifies operation/create conflicts, key reuse, and stale epoch as structured `409` responses without mutation.
  - `[medium]` `[patch]` Receipt identity tests covered only a changed note — focused tests now protect significant item/part order, route subject, and cross-command kind binding.
  - `[medium]` `[patch]` Edge review independently confirmed unsafe aggregate arithmetic — the same safe-aggregate transport guard and regression resolve the duplicated root cause.
  - `[false]` `[reject]` A null or malformed committed operation `result_json` needs a parser — no application path can create that state; the receipt is local, non-importable, and written only by the typed atomic producer.
  - `[false]` `[reject]` A null or malformed committed creation `result_json` needs a parser — the same receipt provenance makes the claimed state unreachable without external database corruption.
  - `[medium]` `[patch]` The claimed matrix and receipt-identity coverage omitted creation rejection replay and identity dimensions — the new replay and canonical-identity cases close both evidenced gaps.
  - `[medium]` `[patch]` The production borrower-create UI protocol handoff had no behavioral test — the dialog test now asserts epoch lookup plus the UUID header and complete versioned POST body.
  - `[medium]` `[patch]` Rejected borrower-creation retries were unverified — the new domain test executes both current-validation branches and proves read-only replay.
  - `[medium]` `[patch]` HTTP conflict and protocol-error status mapping was unverified — the API test now asserts exact `409` envelopes and persistence counts.
  - `[medium]` `[patch]` Strict borrower-creation transport had no negative test — integration coverage now rejects missing/invalid keys, wrong version, invalid fields, and unknown keys before borrower or receipt insertion.
  - `[medium]` `[patch]` Verification review independently found unsafe aggregate totals — resolved by the shared safe-aggregate validation and executed transport test.
  - `[false]` `[reject]` The diff cannot prove skill use, subagent use, commit creation, or final status — those are workflow/run-state obligations completed outside the reviewed product diff; review correctly occurred before final commit and result finalization.
  - `[false]` `[reject]` The detailed contract exceeds the story slug's literal content — the invoked workflow is required to resolve the story through repository epic context and code investigation; the resulting contract aligns with that source.
  - `[medium]` `[patch]` Intent review independently observed the React creation adaptation lacked direct evidence — the new outer-surface interaction test covers the actual form-to-HTTP handoff.
  - `[false]` `[reject]` The spec listed verification commands without execution evidence — the workflow intentionally records executed outcomes during Auto Run Result finalization, after review.

## Design Notes

Request identity is canonical because the route emits a fully normalized typed object and the domain hashes an explicitly constructed identity object. Object keys may be stabilized, but arrays must remain untouched because item/part order is behavior. A rejected receipt records only that the exact attempt was rejected; replay always derives current validation from live state. Creation receipts store the committed borrower snapshot so later borrower edits cannot change the replay result.

The current session model has no unauthenticated role and intentionally leaves these operations available to operators. Authorization ordering should still be explicit and testable with a route harness, but the story must not manufacture a new guest state or elevate the commands to admin-only.

## Verification

**Commands:**
- `pnpm exec vitest run tests/domain/borrower-operation.test.ts tests/integration/borrower-workflow-api.test.ts` -- expected: all command, transport, rollback, allocation, conflict, and replay cases pass.
- `pnpm exec prettier --check .` -- expected: no formatting drift.
- `pnpm lint` -- expected: zero warnings/errors.
- `pnpm typecheck` -- expected: browser and server command contracts compile.
- `pnpm test` -- expected: complete suite passes.
- `pnpm build` -- expected: production server and web bundles succeed.
- `git diff --exit-code -- _bmad-output/implementation-artifacts/sprint-status.yaml _bmad-output/planning-artifacts` -- expected: orchestrator state and frozen planning artifacts remain unchanged.

## Auto Run Result

Status: done

### Summary

Story 1.2 now exposes receipt-backed version-1 commands for atomic mixed borrower operations and borrower creation. Each command validates the current ledger epoch before receipt access, binds idempotency to canonical request identity, performs deterministic live validation and return allocation inside one SQLite transaction, writes only ordinary ledger events, inserts its receipt last, and returns explicit committed, conflict, protocol-error, or rejected-replay outcomes. The existing borrower-creation form now supplies the required epoch, version, and UUID key.

### Files Changed

- `src/contracts/borrower-workflow.ts` — makes committed creation replay state explicit.
- `src/domain/inventory.ts` — implements atomic commands, canonical receipt handling, fresh replay validation, collision detection, deterministic allocation, and rollback-safe receipt-last writes.
- `src/server/routes.ts` — adds strict command schemas, aggregate validation, concrete field errors, authorization ordering, exact status mapping, and the operation endpoint.
- `src/web/App.tsx` — adapts borrower creation to the versioned epoch/idempotency protocol.
- `tests/domain/borrower-operation.test.ts` — covers transaction ownership, allocation, conflicts, rollbacks, identity, epoch safety, creation collisions, and both replay modes.
- `tests/integration/borrower-workflow-api.test.ts` — covers strict transport, authorization precedence, `201`/`409` envelopes, replay, protocol errors, and no-mutation guarantees.
- `tests/web/app-dialogs.test.tsx` — verifies the production creation form's epoch lookup and exact command handoff.
- `_bmad-output/implementation-artifacts/spec-1-2-commit-borrower-operations-and-creation-atomically.md` — records the implementation contract, review triage, and verification evidence.

### Review Findings

The first review reported 23 findings: high 0, medium 13, low 3, false 7, and maybe-false 0. Patches were applied to 7 medium root-cause entries and 2 low entries: aggregate arithmetic, multi-field creation collisions, unknown-key paths, cross-checkout allocation coverage, rejected-creation replay, canonical receipt identity, HTTP conflict/protocol mapping, strict create validation, and the outer borrower-create UI handoff. Nothing was deferred. Rejected findings concerned a nonexistent single-line-note rule, unsupported plain-HTTP LAN deployment, unreachable externally corrupted receipt rows, interim workflow evidence not yet expected in the diff, and the workflow's legitimate derivation of a detailed contract from repository context.

Follow-up review recommended: true. Patched entries this pass: high 0, medium 7, low 2. The specific unverified risk is interaction among the newly tightened aggregate validator, replay branches, and expanded HTTP/UI protocol tests; an independent follow-up pass should check for second-order regressions after this clustered patch set.

### Verification Performed

- Focused domain, API, and UI suites: 3 files, 41 tests passed after review patches.
- Full Vitest suite: 14 files, 108 tests passed.
- Prettier repository check: passed after formatting the final test-only typing correction.
- ESLint: passed with zero warnings or errors.
- TypeScript client and server checks: passed. An initial post-review run exposed a test-only array-index inference error; explicit typed fixture groups corrected it before final verification.
- Production server and Vite web build: passed.
- Diff whitespace check: passed.
- Baseline-aware protected-path inspection: no change to `sprint-status.yaml` or frozen planning artifacts.
- Matrix audit: all eight I/O rows are covered by focused tests that ran and passed, including middle-append and final-receipt rollback.

### Residual Risks

No known functional defect remains. Follow-up review is recommended solely because seven medium review entries were patched in the first pass, not because verification is failing. Story 1.3 still owns durable in-flight attempt state and unknown-outcome UI recovery; those behaviors were intentionally not introduced here.
