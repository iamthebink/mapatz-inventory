---
title: 'Core front-desk inventory workflow'
type: 'feature'
created: '2026-08-15'
status: 'done'
baseline_commit: 'f1b7cfc53dd4aac105c6cd77b9daee857620b77c'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Mapatz needs a fast Hebrew system that works without internet while operators issue consumables and track non-consumables by borrower. The first release must be a truthful loop administrators can exercise and refine.

**Approach:** Build one Dockerized TypeScript/React application with mounted SQLite. Deliver role modes, catalogs, quantity inventory, checkout/return, damage/loss handling, and an immutable ledger from which current state is derived.

## Boundaries & Constraints

**Always:** Hebrew RTL UI with LTR item codes; every screen stays visible while forbidden mutations are disabled and rejected server-side. Name/code search uses case-insensitive fragments and admin-managed aliases. Upward role changes require the target password; downward changes do not. Admin/operator fall to guest after 60/300 idle seconds, warned 10 seconds before expiry. Consumables have optional positive `lotSize`, are issued without borrowers, and never track opened lots. Non-consumables require an active borrower. Borrowers have case-insensitive unique usernames (2-40 trimmed characters), names (1-100), free-text contact (max 500), and type `individual`, `camp_organization`, or `other`. Item codes are monotonic from 100. Seed editable locations `monster`/`מפלצת`, `submarine`/`צוללת`, and `kabira`/`כבירא`. Corrections use compensating ledger events. Operators create borrowers, issue, check out, and return usable/damaged quantities. Admins manage catalogs/passwords/stock, archive, repair/write off damage, and mark/unmark loss. Prevent negative availability, over-return, and archiving records with outstanding equipment.

**Ask First:** Destructive reset, ledger mutation/deletion, weaker server authorization, or schema choices blocking later import/export, reports, or backups.

**Never:** Track instances, opened lots, operator identity/actions, or laptop lock state; require network; implement spreadsheets, cloud recovery, or reports in this slice.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| Role elevation | Guest/operator selects a higher mode | Correct password grants role and returns idle deadline | Wrong password leaves role unchanged with Hebrew error |
| Non-consumable checkout | Active borrower; enough stock | Append checkout events; availability falls | Atomically reject inactive borrower or insufficient stock |
| Consumable issue | Consumable; enough stock | Append borrower-free issue event | Reject borrower, invalid quantity, or insufficient stock |
| Partial return | Quantity within outstanding line | Append usable/damaged return | Atomically reject any over-return |
| Lost lifecycle | Admin marks/unmarks checkout quantity | Move lost/outstanding projections immutably | Reject wrong role or excessive quantity |
| Idle timeout | No interaction before deadline | Warn, then UI/server become guest | Stale mutation returns 401/403 and syncs UI |
| Archive | Admin archives catalog record | Hide from pickers; preserve history | Reject record with active loan |

</frozen-after-approval>

## Code Map

- `package.json`, `pnpm-lock.yaml`, TypeScript/Vite configs -- build/test foundation; no existing code to reuse.
- `Dockerfile`, `.dockerignore`, `.env.example`, `.gitattributes` -- Windows-portable image, mounted data, secrets, line endings.
- `src/db/migrations/001_initial.sql`, `src/db/database.ts` -- schema including item aliases, code sequence, seeded locations, SQLite transactions/settings.
- `src/domain/{types,inventory}.ts` -- event vocabulary, projections, commands, invariants.
- `src/server/{session,routes,index}.ts` -- scrypt credentials, idle roles, validated API, asset serving.
- `src/web/{App,api,styles}.*` -- RTL shell, mode control, catalogs, issue/checkout/return/admin flows.
- `tests/{domain,integration}/` -- isolated-database invariant and API tests.
- `README.md` -- Docker/development operation and deferred scope.

## Tasks & Acceptance

**Execution:**
- [x] Root configs/container files -- establish reproducible Node/React/SQLite build, test, and Docker commands.
- [x] `src/db/`, `src/domain/` -- implement constrained append-only persistence, transactional commands, and projections.
- [x] `src/server/` -- expose validated APIs with credentials and server-enforced role expiry.
- [x] `src/web/` -- build the Hebrew RTL permission-aware workflows.
- [x] `tests/`, `README.md` -- cover the matrix/code/archive rules and document operation/deferred scope.

**Acceptance Criteria:**
- Given fresh mounted data and bootstrap passwords, when the container starts, then migrations are idempotent and locations/code 100 are available.
- Given completed commands, when inventory and loans are queried after restart, then they reconcile with immutable events.
- Given each role, when mutations are attempted, then UI and API match the permission matrix.
- Given a 1280x720 browser, when an operator checks out and partially returns via name-fragment or code search, then the Hebrew flow is readable, keyboard-usable, and offline.

## Spec Change Log

## Design Notes

React uses same-origin routes; domain commands own invariants; SQLite owns atomic persistence. Replaceable read models let later reports/exports consume the ledger. Bootstrap passwords come from environment variables, persist only as salted scrypt hashes, and are admin-changeable; sessions identify privilege only.

## Verification

**Commands:**
- `pnpm lint && pnpm typecheck && pnpm test` -- expected: all static, domain, and integration checks pass.
- `pnpm build` -- expected: production server and Hebrew web assets build without errors.
- `docker build -t mapatz-inventory .` -- expected: image builds with mounted `/data`; current remote Docker context may prevent local execution.

**Manual checks (if no CLI):**
- Exercise roles/timeouts, checkout, usable/damaged return, and lost/unlost in Hebrew RTL.

## Suggested Review Order

**Domain truth and persistence**

- Start with the event-derived model and command boundary that protects inventory truth.
  [`inventory.ts:18`](../../src/domain/inventory.ts#L18)

- Review partial return and lost-state transitions where loan quantities change meaning.
  [`inventory.ts:141`](../../src/domain/inventory.ts#L141)

- Inspect the append-only schema and immutable-ledger enforcement.
  [`001_initial.sql:47`](../../src/db/migrations/001_initial.sql#L47)

- Confirm migrations execute once while remaining extensible for later versions.
  [`database.ts:18`](../../src/db/database.ts#L18)

**Authorization and API boundary**

- Review bootstrap credentials, idle expiry, bounded sessions, and password revocation together.
  [`session.ts:13`](../../src/server/session.ts#L13)

- Follow request session binding, structured errors, and API fallback behavior.
  [`index.ts:19`](../../src/server/index.ts#L19)

- Inspect the role-gated command surface and validation contracts.
  [`routes.ts:31`](../../src/server/routes.ts#L31)

**Operator and administrator experience**

- Review refresh and mutation coordination before individual screens.
  [`App.tsx:30`](../../src/web/App.tsx#L30)

- Walk the consumable issue and borrower checkout surface.
  [`App.tsx:144`](../../src/web/App.tsx#L144)

- Inspect complete catalog, adjustment, damage, location, and password controls.
  [`App.tsx:162`](../../src/web/App.tsx#L162)

**Verification and operation**

- Domain tests defend persistence, projections, corrections, aliases, and archive invariants.
  [`inventory.test.ts:11`](../../tests/domain/inventory.test.ts#L11)

- Integration tests cover every matrix row plus review-found regressions.
  [`api.test.ts:24`](../../tests/integration/api.test.ts#L24)

- Finish with Docker startup, mounted persistence, roles, and deferred scope.
  [`README.md:5`](../../README.md#L5)
