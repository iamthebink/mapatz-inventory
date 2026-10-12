---
title: 'Synchronize Windows release lifecycle tests'
type: 'bugfix'
created: '2026-10-12'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

Windows release verification intermittently fails because desktop tests observe navigation or main-process state before the corresponding renderer/client lifecycle has settled. Synchronize the packaged roundtrip test with borrower recovery readiness before graceful close and after relaunch, and wait for Playwright's window collection to observe destruction in the storage-clear failure test. Preserve all behavior assertions, production behavior, and release gates; do not add retries or inflate timeouts. No compatibility work or database migration is needed, as confirmed by Or.

</frozen-after-approval>

## Implementation Notes

- Small reversible test-only change in tests/desktop/packaged.spec.ts; no new API or unresolved intent gap. Release publication is an already authorized follow-on operation, separate from this code change.
- Release 38277580478 attempt 1 fails the immediate zero-window assertion; main.ts destroys the renderer before clearStorageData throws, but Playwright's window collection receives asynchronous lifecycle events.
- Attempt 2 trace proves utility-process proof and diagnostics complete before Close context hangs. Screenshot shows BorrowerWorkflow loading recovery. Navigation alone does not establish close readiness; the existing freshApp helper already waits for the borrower searchbox to be enabled.
- Validate formatting, lint, types, focused local packaged tests, independent review, then full branch CI and complete release workflow against the fixed commit. Publish 0.5.2 only through the existing checked workflow.
- Implemented three bounded readiness assertions only: enabled borrower search before graceful close and after relaunch; polled zero-window count after storage failure. No production/helper/workflow changes.
- Windows trace: proof assertion passed at 7354ms, diagnostics completed at 7869ms, Close context began at 7923ms and hung until the 60000ms test deadline; screenshot shows borrower recovery still loading. This rules out the proof Promise and diagnostic capture as causes of this observed timeout.
- Local existing Mac ARM64 package: both changed tests pass five repetitions each (10/10 in 20.6s). Prettier, ESLint, both TypeScript configurations, and git diff whitespace checks pass. Windows and rebuilt artifacts remain CI validation responsibilities.

## Review Triage Log

- Low / addressed by required validation: reviewer requested Windows evidence before calling stabilization verified. Local implementation is complete; Windows correctness remains explicitly pending full branch/release CI, whose run IDs and final outcomes will be recorded here before delivery.
- Low / rejected additional delay fixture: reviewer found no correctness defect but suggested deliberately delayed recovery or equivalent Windows evidence. The actual failed Windows trace and screenshot already establish close occurring during recovery loading; the new existing-readiness assertion cannot complete until that state exits. Full rebuilt Windows verification remains required. No new timing fixture is needed for this small synchronization correction.
