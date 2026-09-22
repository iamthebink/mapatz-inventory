---
title: 'Compact Lost Equipment Accordion and Quantity Spacing'
type: 'feature'
created: '2026-09-22'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The borrower status tables' quantity values sit too close to the right edge of their cells, while the closed lost-equipment accordion looks like a large card with a detached count badge.

**Approach:** Give the quantity columns a little more right-side breathing room and make the lost section a compact, conventional disclosure line: a small left-pointing arrow before `ציוד אבוד של השואל` and its lost-unit count in parentheses, e.g. `◀ ציוד אבוד של השואל (1)`. Keep the existing native accordion and its contents and actions.

</frozen-after-approval>

## Implementation Notes

- `src/web/BorrowerOperationalTables.tsx`: changed the lost `<summary>` from a title plus detached unit badge to a title and parenthesized lost-unit total, with an explicit accessible name. Native `<details>` behavior, table identity, and recovery actions remain unchanged.
- `src/web/styles.css`: removed the lost section's card chrome and badge styling, made a compact disclosure row with a leading RTL-aware triangle that points down when expanded, and increased logical right padding for held/lost quantity headers and cells (18px desktop, 11px narrow). Reduced-motion preferences disable the arrow transition.
- `tests/web/borrower-workflow.test.tsx` and `tests/e2e/borrower-workflow.spec.ts`: updated dynamic total assertions, checked the summary's accessible name and initial collapsed state, and checked quantity-column right padding at desktop and 320px. Targeted web and browser tests passed; a temporary desktop capture visually confirmed the compact closed line, then the capture hook was removed.
- The first full browser run exposed an assertion-order mistake: the 320px test checked a held row after staged actions had removed it. The held padding check now runs before those actions, and the lost padding check runs after the accordion opens; both focused cases pass. Blind review also led to an accessible name that announces `יחידה`/`יחידות` while keeping the visible count parenthesized, and an assertion that the replacement marker is present and rotates downward.
- Final verification: 296/296 Vitest tests, 21/21 borrower Chromium E2E tests, both TypeScript checks, repository ESLint, targeted Prettier, production build, and `git diff --check` passed.

## Review Triage Log

| Finding | Verdict and evidence |
| --- | --- |
| Accessible count lacks a unit | low · patched: the visible `(N)` remains, while the summary's accessible name announces the unit in singular or plural. |
| Replacement marker is not verified | low · patched: the browser test checks the pseudo-marker's width and its rotation from left to down on expansion. |
