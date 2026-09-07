---
title: 'Use action-specific toast titles'
type: 'feature'
created: '2026-09-07'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Toast titles currently repeat generic severity labels such as `הצלחה`, `אזהרה`, and `שגיאה`, so feedback is visually disconnected from the operation that produced it.

**Approach:** Make every toast carry and display an action-specific Hebrew title. Reuse the same action title across that operation's success, refresh-warning, and error outcomes while preserving the existing body copy, tone styling, accessibility semantics, dismissal behavior, and confirmation-dialog boundary.

</frozen-after-approval>

## Implementation Notes

- The change is confined to `src/web/Toast.tsx`, the centralized notification/action seams and their call sites in `src/web/App.tsx`, and focused web tests.
- Add `title` to `ToastMessage`; tone metadata should continue to own only icon and live-region role.
- Change the application helpers to accept the action title explicitly, then provide a truthful title for every mutation, import/export, archive toggle, session operation, and background refresh error.
- Preserve server/API error text as the toast body. Keep `הפעולה הושלמה בהצלחה` as the success body and the existing refresh-warning body unchanged.
- Do not change inline form validation, wrong-password feedback, confirmation dialogs, admin-mode announcements, toast timing/motion, or styling.
- Implemented `ToastMessage.title` and made the renderer display caller-provided action copy; severity metadata now controls only icon and live-region role.
- Routed every mutation and import/export through `action(title, operation)`, including dynamic archive, lost-state, damaged-stock, and import titles. Non-mutation refresh and admin-session errors also receive contextual titles.
- Added presentation coverage for caller-provided titles across all three tones plus application-level success, error, and post-success refresh-warning coverage. The requested new-item flow is explicitly protected as `הוספת פריט חדש`.
- Blind review preserved non-visual severity through an accessible toast label, clarified the post-expiry refresh title, hardened the unexpected damage-resolution fallback, and expanded dynamic-title coverage.

## Review Triage Log

- `medium` — Removing the visible severity word also removed the only explicit warning/error distinction for assistive technology; patched with an action-plus-body accessible label prefixed by the tone while keeping the visible title action-specific.
- `medium` — A refresh failure after local admin expiry was titled as though ending admin mode itself had failed; patched to `רענון לאחר סיום מצב מנהל` so the security state remains legible.
- `low` — Mark-lost and unmark-lost conditional titles lacked regression coverage; patched both existing workflow branches with title assertions.
- `low` — Item, borrower, and location archive/restore title directions lacked coverage; patched all six user-visible variants with table-driven interaction tests.
- `low` — Repair/write-off titles lacked coverage and an unexpected resolution inherited the write-off title; patched both supported variants and added a truthful generic fallback for rejected unexpected values.
