---
title: 'Make Borrower Held and Lost Equipment Tabular'
type: 'feature'
created: '2026-09-22'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** In the borrower card, the `אצל השואל N` and `אבוד N` badges sit beside item names and make held/lost equipment rows look cluttered and misaligned.

**Approach:** Present `ציוד אצל השואל` and the expanded `ציוד אבוד של השואל` area as compact, aligned tables resembling the prior borrower-card layout. Give item name, quantity, and actions distinct columns while retaining the lost accordion, its visible lost-unit count, all existing actions, and responsive usability.

</frozen-after-approval>

## Implementation Notes

- Replaced the held and lost flex rows in `src/web/BorrowerOperationalTables.tsx` with separate semantic tables. Item names are row headers; held/lost balances occupy their own numeric columns; actions remain in their existing cells with unchanged refs and handlers. The native lost accordion and its aggregate count are unchanged.
- Reused `.operational-table` in `src/web/styles.css`, sized the three columns, and allowed action labels to wrap at narrow widths without widening the card. Removed obsolete borrower-equipment row styling.
- Updated unit and browser tests to query semantic table rows and assert quantity cells; existing modal/menu, focus, and responsive checks still run. The first browser assertion used an incorrectly scoped Playwright `has` locator; corrected it to locate the row from its row header. A projected quantity assertion was corrected from 1 to 3 because the seeded borrower already held 2 before a staged borrow of 1.
- Verified 295/295 Vitest tests, 21/21 borrower Chromium E2E tests, both TypeScript checks, ESLint, and targeted Prettier. The first unprivileged full Vitest attempt could not bind integration listeners (`EPERM`); the permitted rerun passed.
- Blind review led to accessible names for both tables, row-scoped two-item coverage, exact Playwright row-header matching, and 320px cell-clipping checks. A temporary 320px screenshot showed the full held-quantity heading wrapping into three lines; at widths up to 360px it now displays `כמות` while retaining the full accessible label `אצל השואל`. The screenshot hook was removed after visual QA.
- Final verification: 296/296 Vitest tests, 21/21 borrower Chromium E2E tests, both TypeScript checks, repository ESLint, targeted Prettier, production build, and `git diff --check` passed.

## Review Triage Log

| Finding | Verdict and evidence |
| --- | --- |
| Both tables lack accessible names | low · patched: tables now reference their section heading or accordion summary. |
| Fixed columns make the 320px heading/control layout cramped | medium · patched: visual QA confirmed a three-line quantity heading; the narrow visible heading is now `כמות`, and column proportions were adjusted while controls remain usable. |
| Narrow browser checks do not verify cell clipping | low · patched: the 320px test checks held/lost table cell scroll widths and accessible names; existing interaction and menu-bound checks still pass. |
| Single-item tests miss row/action association | low · patched: a two-item web test checks distinct held/lost balances and opens actions from specific rows. |
| Return helper may match prefixed item names | low · patched: the row-header locator now uses exact matching. |
| Deferred close-on-save entry lacks full behavior decisions | false: the ledger entry is an explicit reminder for a separate future slice, not its implementation contract; the save/refresh behavior must be investigated when that slice starts. |
