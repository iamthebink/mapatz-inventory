---
title: 'Commit Borrower Operations and Creation Atomically'
type: 'feature'
created: '2026-09-08'
status: done
baseline_revision: 9dfc0c4eb14d4e404bfafcfcfca0a4c0a07b0232
baseline_commit: eb49342eeaa7b77cc8d19bc52aa476f8cf4c62c9
review_loop_iteration: 0
followup_review_recommended: false
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

**Always:** Require a UUID idempotency key, contract version 1, and the current positive ledger epoch; validate transport before domain access and compare epoch before receipt lookup. An unsupported `contractVersion` is invalid transport and returns `400 validation_error` before any domain or receipt access, even when the idempotency key was previously used. Receipt identity comparison applies only to otherwise valid version-1 requests. Bind receipt identity to command kind, route subject, epoch, version, and the schema-normalized request while preserving item and part array order. Each public command opens exactly one transaction. Process item groups by item ID, persisted checkouts by `created_at` then event ID, return parts in request order, usable before damaged, all returns before borrows, and never allocate a return to a checkout created by the same command. Persist only `committed` or `rejected` receipt markers, inserting the receipt last. Replays of committed requests return the original result without mutation; rejected replays recompute current validation without mutation. Preserve current operator/admin permissions and place authorization before parsing/domain work. Use existing typed protocol/result unions and ordinary ungrouped ledger events.

**Never:** Add transaction, batch, or receipt fields to `inventory_events`; add grouped history or rollback semantics; persist staged UI state; cache stale rejection reasons; net borrow and return directions; call transaction-owning legacy mutation methods from inside a command; make these operator operations admin-only; broaden UI workflow work beyond the minimal borrower-create transport adaptation; modify the frozen planning baseline or `_bmad-output/implementation-artifacts/sprint-status.yaml`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Mixed commit | Active borrower; valid repeated return and borrow parts across unsorted item groups | One transaction appends allocated usable/damaged returns, then checkouts, in deterministic order; source notes and checkout relations are preserved | Any append or receipt failure rolls back every event and receipt |
| State conflict | Inactive borrower, invalid item, stale returnable balance, or insufficient stock | No events; one rejected receipt; ordered conflicts and a fresh desk snapshot come from the same write boundary | Return receipt-backed `409`; borrower conflict suppresses item conflicts, item prerequisites suppress direction conflicts, invalid return suppresses same-item borrow conflict |
| Committed retry | Same key and canonical version-1 request | Original result is returned with `replayed: true`; no row or event is duplicated | For an otherwise valid version-1 request, a changed body, subject, or kind returns `idempotency_key_reused` without mutation; an unsupported version remains invalid transport (`400 validation_error`), and an epoch mismatch follows the epoch-first rule |
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
- `src/server/routes.ts:24` -- keep ordinary legacy schemas separate; add strict nested command schemas, UUID header parsing, authorization-before-body-parsing and validation, exact status mapping, `POST /borrowers/:id/operations`, and route `POST /borrowers` through atomic creation. Route-local command parsers must not become the parser for legacy endpoints.
- `src/server/index.ts:29` -- preserve pre-session JSON parsing for every legacy API request while bypassing that parser only for the two exact command routes, whose authorization must precede their route-local parsers. Malformed legacy traffic must still fail before session lookup/allocation, retain the generic `{error,message}` contract, and never consume or evict a session.
- `src/server/session.ts` -- read-only permission evidence: the runtime has only operator/admin roles and expiration downgrades admin to operator; preserve operator access rather than inventing an unreachable guest policy.
- `src/web/App.tsx:1266` -- minimally adapt the existing create-borrower POST to obtain/use the current epoch and send `Idempotency-Key`, without implementing Story 1.3 frozen-attempt persistence or workflow state.
- `tests/domain/borrower-operation.test.ts` -- new focused command tests for allocation order, conflict precedence, exact one-transaction ownership, rollback, canonical identity, both replay modes, epoch-first behavior, and normalized creation conflicts.
- `tests/integration/borrower-workflow-api.test.ts` -- extend exact POST validation, status/envelope, replay, mismatch, authorization-order, and no-mutation transport coverage. Exercise command parser ordering and legacy parser/session ordering at their real application-composition surfaces; cover authorized malformed/oversized bodies on both commands, unsupported-version precedence for both commands including a simultaneous stale epoch, exact isolated field-error order with no echoed key, replay non-mutation after borrower edits, and complete tie-break persistence assertions.
- `_bmad-output/implementation-artifacts/sprint-status.yaml`, `_bmad-output/planning-artifacts/**` -- explicit read-only boundaries.

## Tasks & Acceptance

**Execution:**
- [x] `src/contracts/borrower-workflow.ts` -- make committed creation results identify first execution versus replay -- keep retry behavior explicit and statically checked.
- [x] `src/domain/inventory.ts` -- implement both receipt-backed commands and private deterministic validation/allocation helpers under one transaction each -- make command success, rejection, replay, and failure atomic without changing ledger meaning.
- [x] `src/server/index.ts`, `src/server/routes.ts` -- add strict command validation, key parsing, authorization ordering, operation routing, and exact HTTP result mapping; replace legacy borrower-create transport with the versioned command; selectively preserve legacy pre-session parsing while parsing only the two command routes after authorization -- reject malformed command requests before domain access without letting malformed legacy traffic allocate or evict sessions.
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

### 2026-09-08 — Preserve legacy parser/session ordering during command authorization split

- Trigger: review showed that moving the shared JSON parser wholly into `apiRouter` made malformed legacy requests allocate sessions before parser rejection, so bounded-session eviction became possible; the synthetic authorization regression also did not exercise the production app composition where that regression originated.
- Amendment: the Code Map and execution/test instructions now require a selective pre-session legacy parser at `createApp`, route-local post-authorization parsers only for the two exact command routes, direct protection of legacy no-session-on-parse-failure behavior, and the remaining command precedence/non-mutation assertions.
- Known-bad state avoided: a global parser ahead of command authorization violates the command invariant, while a shared parser after session resolution changes unrelated legacy failure semantics and permits malformed traffic to consume session capacity.
- KEEP: retain route-level `requireRole` before command parsing; retain the 32 KiB parser limit and generic `invalid_json` envelope; retain version-1-before-domain validation, epoch-first receipt handling for valid requests, the expanded replay/allocation tests, and every existing atomic domain/receipt behavior from the baseline.

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

### 2026-09-08 — Follow-up review pass
- verdicts: 21 findings — high 0, medium 14, low 0, false 7, maybe-false 0
- findings:
  - `[medium]` `[bad_spec]` Global JSON parsing precedes route authorization — `express.json()` runs before session resolution and `requireRole`, so malformed or oversized unauthorized command bodies are parsed first; the planning sections failed to account for the application middleware boundary.
  - `[false]` `[reject]` Malformed JSON must use the command `validation_error` envelope — malformed JSON never becomes a schema-level command body, and the existing application intentionally maps parser failures through the generic `invalid_json` contract.
  - `[false]` `[reject]` `parseCommand` permits schema/request drift — its `schema: ZodType<T>` parameter statically constrains the schema output to the explicitly supplied request type; the post-success casts do not remove that call-site check.
  - `[medium]` `[patch]` Creation-route authorization ordering lacks a regression — only the operations route is exercised with invalid transport under a denied role, so the equivalent creation invariant remains unprotected; patching is moot until the intent gap is resolved.
  - `[false]` `[reject]` Expired-session command behavior is untested — expiration deliberately downgrades admin to operator, and operators remain authorized for both commands, so there is no expired/forbidden command state to protect.
  - `[medium]` `[patch]` Same-kind borrower-creation key reuse with a changed body lacks coverage — existing creation replays reuse the identical body, leaving creation request-hash completeness unprotected; patching is moot until the intent gap is resolved.
  - `[medium]` `[patch]` The operation route lacks stale-epoch HTTP coverage — domain coverage proves operation ordering and HTTP coverage proves creation mapping, but the operation route's complete transport/status/no-mutation path is not exercised; patching is moot until the intent gap is resolved.
  - `[medium]` `[patch]` Damaged returns are not proven unable to fund a same-command borrow — the implementation counts only usable returns, but the focused tests never make success depend on incorrectly counting damaged stock; patching is moot until the intent gap is resolved.
  - `[false]` `[reject]` A new checkout could satisfy an excessive same-command return without a regression — the existing return-conflict test requests a return above persisted balance together with a much larger borrow and asserts the return conflict and unchanged event count.
  - `[medium]` `[patch]` Rejected-operation replay does not prove its snapshot is fresh — replay assertions cover current validation status but not the post-mutation snapshot fields; patching is moot until the intent gap is resolved.
  - `[medium]` `[patch]` Checkout tie-breaking is not explicitly protected — allocation assertions follow event ID order, but the test neither forces nor verifies equal `created_at` values, so the secondary ordering invariant is not isolated; patching is moot until the intent gap is resolved.
  - `[false]` `[reject]` The borrower-create UI mock must return the real `201` result — the current UI intentionally ignores the command result and refreshes catalog state, so a `204` mock still exercises the specified request adaptation without masking response consumption.
  - `[medium]` `[bad_spec]` Unauthorized malformed JSON reaches the global parser before authorization — this independently confirms the first finding's application-middleware root cause; the planning sections omitted the outer parser surface.
  - `[medium]` `[intent_gap]` Changed contract version has contradictory required outcomes — strict version-1 transport validation before domain access requires `400 validation_error`, while the committed-retry matrix requires the same reused key with a changed version to reach receipt comparison and return `409 idempotency_key_reused`; the attempted implementation is preserved at `_bmad-output/implementation-artifacts/spec-1-2-intent-gap-2026-09-08.patch`.
  - `[false]` `[reject]` A reused key with a stale epoch should return `idempotency_key_reused` — the intent explicitly makes `ledger_epoch_changed` win before receipt lookup, including when an old receipt exists.
  - `[medium]` `[patch]` Most nested operation-validation rules are only tested inside one omnibus-invalid payload — independently removing several refinements would leave the asserted unknown-key failure green; table-driven isolated cases are needed after the intent gap is resolved.
  - `[medium]` `[patch]` Borrower-creation changed-body key reuse is unverified — repository-wide test tracing confirms no same-command changed-field retry with persistence counts; this is the same test-gap root cause as the sixth finding and is moot until intent resolution.
  - `[medium]` `[patch]` Creation epoch precedence is not tested with an existing old receipt — the fresh-key HTTP case cannot distinguish epoch-first from receipt-first handling; patching is moot until the intent gap is resolved.
  - `[medium]` `[patch]` Committed creation replay is not checked after the borrower changes — immediate replay cannot detect an implementation that reloads mutable borrower state instead of returning the stored result; patching is moot until the intent gap is resolved.
  - `[medium]` `[patch]` Rejected-operation replay freshness lacks snapshot assertions — repository-wide tracing confirms validation status is checked but intervening inventory and holding state are not; this shares the tenth finding's test-gap root cause and is moot until intent resolution.
  - `[false]` `[reject]` The diff fails the operator-facing inventory-mutation reading — the intent's explicit boundary says to adapt only borrower creation and forbids broader UI workflow work, so the domain/HTTP operations substrate plus creation UI adaptation is the defensible scoped reading.

### 2026-09-08 — Review pass
- verdicts: 14 findings — high 0, medium 8, low 1, false 5, maybe-false 0
- findings:
  - `[medium]` `[bad_spec]` The unauthorized-command regression mounted `apiRouter` directly and could not detect a parser reintroduced ahead of it in `createApp` — the production composition owns that ordering, so the spec now requires coverage at the real composition seam while preserving the synthetic denied-role proof.
  - `[medium]` `[patch]` Authorized malformed and oversized command bodies were not exercised on either route — the route-local parsers are a new independent surface; add exact `invalid_json`, no-domain-call, and no-receipt assertions during re-derivation.
  - `[medium]` `[patch]` Unsupported-version precedence with an existing borrower-creation receipt was unverified — creation has a separate schema/route path; add the equivalent reused-key case during re-derivation.
  - `[medium]` `[patch]` Unsupported version was not combined with a stale epoch — the separate cases would miss an implementation that consulted the epoch before rejecting version 2 only in the combined state; add the combined no-domain-access assertion during re-derivation.
  - `[medium]` `[patch]` Committed creation replay did not prove the live borrower remained edited — the stored result assertion alone permits a hidden write-back; assert persisted state is unchanged during re-derivation.
  - `[low]` `[patch]` The equal-timestamp allocation test asserted the chosen relation but not complete commit cardinality — add direct result, event/receipt count, and remaining-returnable assertions during re-derivation because these are simple assertions around the same fixture.
  - `[medium]` `[patch]` Isolated transport cases used containment rather than exact ordered errors and omitted the no-key assertion — strengthen each case during re-derivation so spurious or reordered errors cannot pass.
  - `[false]` `[reject]` The prior review log contains duplicated root causes and historical “moot” wording — one row per reported finding is a workflow invariant, and the wording truthfully records the state of that earlier pass; rewriting it would corrupt review provenance.
  - `[false]` `[reject]` The in-review spec lacked an `Auto Run Result` — finalization intentionally writes executed evidence only after review and any repair loop, so absence at this stage is correct.
  - `[medium]` `[bad_spec]` Moving all legacy parsing after session resolution lets malformed cookie-less traffic allocate sessions and eventually evict valid ones — comparison with the baseline confirms parsing previously failed before `SessionStore.get`; the spec now requires selective pre-session parsing for legacy routes and post-authorization parsing only for command routes.
  - `[false]` `[reject]` The baseline diff does not itself introduce the core domain, receipt, or UI feature — this is a resumed hardening pass whose baseline already contains those surfaces; the reviewed delta correctly focuses on unresolved review findings.
  - `[false]` `[reject]` The follow-up diff has no borrower-create UI delta — the baseline already contains and tests that adaptation, and the intent explicitly excludes broader workflow UI.
  - `[medium]` `[bad_spec]` The authorization proof exercises a synthetic router rather than the production assembly — this is the same parser-composition root cause as the first and tenth findings; the amended spec requires both the denied-role router proof and production legacy/session-order coverage.
  - `[false]` `[reject]` Mutating the implementation spec might violate the frozen planning baseline — the frozen paths are planning artifacts and orchestrator-owned sprint status; this tracked implementation spec is the workflow's required mutable record, and its intent clarification predated this implementation pass.

### 2026-09-08 — Review pass
- verdicts: 19 findings — high 0, medium 12, low 1, false 6, maybe-false 0
- findings:
  - `[medium]` `[patch]` The command classifier was case-sensitive while Express routes are case-insensitive — normalized `req.path` before classification and added an uppercase production-composition regression, preserving authorization-before-parsing for accepted aliases.
  - `[false]` `[reject]` Denied-role coverage still mounts `apiRouter` directly — the separate `createApp` malformed-command test spies on session resolution and detects any pre-router parser, while the synthetic harness is intentionally the only reachable way to prove denial before route-local parsing because production sessions are always operator/admin.
  - `[false]` `[reject]` Duplicating the two command paths in the classifier necessarily creates a current drift defect — after matching Express case semantics the classifier and router cover the same two specified routes; a hypothetical future command must deliberately extend both, but no present caller diverges.
  - `[medium]` `[patch]` Version-precedence setup did not prove its commands committed or created receipts — added `201` assertions and an exact two-receipt precondition before the retry checks.
  - `[medium]` `[patch]` Unsupported-version checks omitted the exact validation envelope — both command assertions now verify the full top-level body plus field path, code, and message.
  - `[medium]` `[patch]` Creation epoch-first behavior lacked an existing-receipt case — added a valid version-1 retry of the committed creation key after the epoch advances and proved `ledger_epoch_changed` with unchanged persistence.
  - `[low]` `[patch]` Changed-body creation reuse protected only row counts — reasserted the complete edited borrower row after the protocol error.
  - `[medium]` `[patch]` Rejected operation replay protected only receipt count — snapshotted and compared the complete receipt row across both current-validation replay branches.
  - `[medium]` `[patch]` Isolated validation omitted empty borrow and return arrays — added exact independent cases for both `.min(1)` constraints.
  - `[medium]` `[patch]` Isolated validation omitted unsafe borrow quantities — added the exact per-part and aggregate error sequence.
  - `[medium]` `[patch]` Isolated validation omitted negative usable and damaged components — added independent exact cases whose positive totals cannot mask the component violations.
  - `[medium]` `[patch]` The isolated table discarded externally visible top-level and message fields — every case now asserts the complete ordered validation envelope.
  - `[medium]` `[patch]` Case-variant command paths could enter the legacy parser before authorization — fixed by lowercasing the classifier path before applying the route-equivalent expressions.
  - `[medium]` `[patch]` The classifier did not share Express's case-insensitive acceptance semantics — the same normalization fix and production uppercase regression close the mismatch.
  - `[medium]` `[patch]` Verification reproduced malformed uppercase creation bypassing session resolution and found no case-variant test — the classifier now normalizes case and the focused production test covers an uppercase command alias.
  - `[false]` `[reject]` The delta is not a standalone implementation of the whole story — this run resumes a completed baseline for review hardening; the baseline already contains the domain, receipt, contract, and UI implementation.
  - `[false]` `[reject]` Tests exercise behavior supplied by the baseline rather than only new production lines — that is deliberate regression hardening of cumulative story invariants, not an intent divergence.
  - `[false]` `[reject]` Absence of an inventory-operations UI or new borrower-create UI delta is divergent — the immutable intent expressly limits UI work to the already-present borrower-create adaptation and excludes the broader workflow.
  - `[false]` `[reject]` Changing implementation-spec baseline metadata violates the frozen baseline — the protected baseline is explicitly planning artifacts plus orchestrator-owned sprint status; this implementation spec is required mutable workflow evidence.

### 2026-09-08 — Review pass
- verdicts: 20 findings — high 0, medium 9, low 2, false 9, maybe-false 0
- findings:
  - `[false]` `[reject]` The command-path classifier duplicates route matching and could drift after a future route change — carried: the prior pass already established that the two specified routes currently match Express semantics; a hypothetical future command is not a present defect.
  - `[false]` `[reject]` Unsupported-version precedence needs same-epoch retries against existing receipts — the route's literal-version schema rejects before any service call, and the test already creates both receipts, proves no domain call, and combines the invalid version with a stale epoch; same-epoch duplication cannot expose receipt-first behavior hidden by that boundary.
  - `[medium]` `[patch]` Isolated operation-validation cases did not prove the domain command was never invoked — added a `commitBorrowerOperations` spy to every table case and asserted zero calls alongside the exact envelope and zero receipts.
  - `[medium]` `[patch]` Case-insensitive parser classification covered only the operations route — added malformed uppercase borrower-creation coverage through the production app.
  - `[medium]` `[patch]` Optional trailing slashes accepted by both command routes lacked parser-order coverage — added malformed creation and operation requests with trailing slashes to the production classifier test and the denied-role route table.
  - `[low]` `[patch]` A negative command-path near-match was not protected against future over-broad classification — the exact anchored expressions already reject it; the expanded legacy parser test protects the adjacent non-command branch without changing production behavior.
  - `[low]` `[patch]` Oversized legacy JSON did not have the same no-session regression as malformed legacy JSON — added an oversized legacy request and retained the zero-session-call assertion.
  - `[medium]` `[patch]` Stored borrower-creation replay used a partial response assertion — replaced it with the exact committed envelope and complete original borrower snapshot after the live borrower was edited.
  - `[medium]` `[patch]` Changed-body borrower-creation key reuse asserted only the error code — replaced it with the complete protocol-error envelope.
  - `[medium]` `[patch]` Committed operation replay asserted only `replayed: true` — replaced it with the exact committed replay envelope.
  - `[medium]` `[patch]` Stale-epoch HTTP checks compared receipt counts but not receipt contents — snapshot and compare all receipt rows around both stale retries.
  - `[false]` `[reject]` The previous review log overclaimed complete creation validation envelopes — that historical row describes the isolated operation table it amended; creation validation is separately covered with deterministic ordered fields, no echoed key, and no persistence.
  - `[medium]` `[patch]` Malformed percent-encoding in a command path surfaced as `500 internal_error` — reproduced the reachable Express `URIError`, mapped its framework `status: 400` to `400 invalid_path`, and added a production-composition regression.
  - `[false]` `[reject]` Contract-version changes should be receipt-identity mismatches returning `409` — the intent explicitly limits receipt comparison to otherwise valid version-1 requests and requires unsupported versions to return transport `400` before domain access.
  - `[medium]` `[patch]` Trailing-slash command variants could regress to pre-authorization parsing without a failing test — the same route-parity patch adds both variants at the production and denied-role surfaces.
  - `[false]` `[reject]` The follow-up diff's production lines do not implement the contract's central domain transaction surface — carried: this is a cumulative follow-up review whose baseline commit already implements the domain, receipt, route, contract, and UI surfaces.
  - `[false]` `[reject]` Broad regression tests exercise behavior supplied by the baseline rather than only new production lines — carried: cumulative invariant protection is deliberate review hardening, not divergence from the story intent.
  - `[false]` `[reject]` The follow-up diff contains no inventory-operations UI or borrower-create UI delta — carried: the intent expressly excludes the broader operations UI, and the required borrower-create adaptation already exists in the reviewed baseline.
  - `[false]` `[reject]` Receipt schemas, typed unions, atomic services, and ledger allocation are absent from this follow-up delta — carried: those surfaces are present in the baseline revision and the follow-up diff is correctly limited to defects found after that implementation.
  - `[false]` `[reject]` Updating the implementation spec violates the frozen-artifact boundary — carried: the prohibition names planning artifacts and orchestrator-owned sprint status; this story spec is the workflow's required hand-back artifact.

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

Completed the follow-up hardening pass for the atomic borrower commands. The reviewed cumulative change preserves legacy pre-session parsing, authorizes command routes before their local parsers, strengthens deterministic domain and HTTP evidence, and now returns a deliberate `400 invalid_path` instead of `500` for malformed encoded command paths.

### Files Changed

- `src/server/index.ts` — selectively routes legacy and command JSON parsing and maps malformed URI decoding to a client error.
- `src/server/routes.ts` — keeps command parsing after authorization and relies on Zod's integer safety boundary.
- `tests/domain/borrower-operation.test.ts` — strengthens allocation, damaged-stock, replay-freshness, receipt, and tie-break invariants.
- `tests/integration/borrower-workflow-api.test.ts` — strengthens exact transport envelopes, parser ordering, route equivalence, no-domain/no-session behavior, receipt preservation, and malformed-path handling.
- `_bmad-output/implementation-artifacts/spec-1-2-commit-borrower-operations-and-creation-atomically.md` — records the follow-up review, verification, and terminal result.

### Review Findings

Patches applied: 5 medium entries and 1 low entry after grouping shared root causes. They cover transport-before-domain proof, command-path parity (case, trailing slash, and near-match boundaries), oversized legacy parsing, exact replay/protocol envelopes, receipt-row preservation, and malformed encoded paths. Items deferred: none.

Rejected findings:

- Classifier duplication is a future-maintenance concern, not a current route mismatch; parity is now explicitly exercised.
- Same-epoch unsupported-version retries are redundant because invalid versions cannot cross the route schema into receipt handling.
- The historical validation-envelope statement applies to the isolated operation table, not the separate creation test.
- Version mismatch is not receipt identity under the clarified contract; unsupported versions are transport errors.
- The cumulative follow-up need not re-add domain, receipt, contract, ledger, or UI implementation already present in its baseline.
- Tests that protect baseline behavior are valid cumulative regression evidence.
- No inventory-operations UI is required, and the borrower-create adaptation already exists.
- The story spec is mutable workflow evidence, not part of the frozen planning or sprint-status boundary.

### Follow-up Review Recommendation

`false` — this follow-up pass patched 5 medium entries and 1 low entry, with no high-severity patch entry. Under the follow-up convergence rule, patch volume alone does not require another pass.

### Verification Performed

- `pnpm exec vitest run tests/domain/borrower-operation.test.ts tests/integration/borrower-workflow-api.test.ts` — passed: 2 files, 36 tests.
- `pnpm exec prettier --check .` — passed after formatting the URI-error branch.
- `pnpm lint` — passed with zero warnings/errors.
- `pnpm typecheck` — passed for browser and server configurations.
- `pnpm test` — passed on isolated rerun: 14 files, 126 tests. An initial concurrent run had one transient `socket hang up`; the focused suite and isolated full rerun both passed.
- `pnpm build` — passed; production server compilation and Vite bundle succeeded.
- Direct ledger/receipt invariants — exercised by focused tests, including exact receipt-row preservation, event cardinality/order, rollback, and replay non-mutation.
- Protected paths — `git diff --exit-code -- _bmad-output/implementation-artifacts/sprint-status.yaml _bmad-output/planning-artifacts` passed; neither path was modified.

### Residual Risks

The command-route classifier and Express route declarations remain separate representations by necessity at the application-composition boundary. Exact case, trailing-slash, positive, and negative path tests now make drift observable. No unresolved implementation or intent gap remains.
