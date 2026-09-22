---
title: 'Close Borrower Card After Reviewed Save'
type: 'feature'
created: '2026-09-22'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The borrower card currently labels its review button `בדיקה ושמירה` and remains open after the operator confirms `אישור ושמירה`, requiring a separate close action.

**Approach:** Rename the card action to `אישור פעולות`. Its review dialog retains `חזרה לעריכה` and `אישור ושמירה`; the latter saves and then closes the borrower card after a confirmed successful commit, returning focus to borrower search. A rejected or still-uncertain save must not be presented as a successful close.

</frozen-after-approval>

## Implementation Notes

- Reused the existing `save-and-close` operation intent and its committed/uncertain/conflict recovery state machine; only the review confirmation dispatch changed. The card action now reads `אישור פעולות`, while the review dialog retains `חזרה לעריכה` and `אישור ושמירה`.
- Kept the search surface locked after a confirmed commit whose snapshot refresh fails. The card closes, a warning toast explains the unverified projection, and the operator must explicitly retry truth refresh before searching again.
- Split the directory recovery button ref from the in-card recovery button ref. Sharing it let the card unmount clear the ref and lose keyboard focus after a committed-refresh failure; browser verification exposed this timing issue.
- Independent review found that card visibility alone did not prove a refreshed snapshot was valid. Success now requires the reducer's `closed` phase; stale snapshots and epoch changes keep borrower search locked, with explicit retry and a focused recovery control. An unchanged epoch after reload is retryable rather than leaving a permanently in-flight reload ID.
- A failed local frozen-attempt clear now re-resolves the exact idempotency key through the server before applying the definitive result. This preserves the save-and-close intent without guessing from unrelated ledger movement. Navigation away from the hidden-card recovery state is guarded until verification completes.
- Updated web, browser, and packaged-desktop test labels and close/reopen assertions; removed the completed close-card item from deferred work. No new schema, API, or migration was needed.
- Verification after review corrections: 296 Vitest tests, 22 borrower-workflow Playwright browser tests, TypeScript client/server checks, ESLint, Prettier, and production build passed. The packaged-desktop suite was not run; its affected button label was updated.

## Review Triage Log

- `high` — A stale refresh snapshot could leave `refresh-required` while `cardOpen` was false, causing false success. Confirmed in the reducer's invalid-snapshot branch; patched to require `phase.kind === 'closed'` and added stale-snapshot browser coverage.
- `high` — Retrying an unchanged snapshot could incorrectly release search. Confirmed in `refreshOperation`; patched to retain recovery unless the reducer closes, covered by the stale-snapshot test.
- `high` — An unchanged epoch after `reload-succeeded` could leave `reload-required` but still trigger a close, or retain an in-flight reload ID. Confirmed in the reducer; patched to stay blocked and normalize to retryable `reload-failed`, covered by the epoch browser test.
- `medium` — A failed frozen-attempt clear could forget the save-and-close intent. Confirmed: the old branch rebuilt a ready operation without resolving the outcome. Patched to re-resolve the exact durable envelope; the existing storage-recovery UI test now checks same-key replay and closure.
- `medium` — Navigation could discard the hidden-card recovery state. Confirmed via `requestExit`'s `!selectedBorrower` branch; patched to guard navigation until truth verification finishes.
- `false` — The review dialog's `אישור ושמירה` label does not mention closing. The user explicitly specified that exact label and its close behavior, so changing it would contradict the approved copy rather than fix a defect.
