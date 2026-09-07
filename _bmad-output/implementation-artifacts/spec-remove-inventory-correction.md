---
title: 'Remove inventory correction'
type: 'feature'
created: '2026-09-07'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The inventory correction action is ambiguous: its copy suggests entering a physical count while its behavior subtracts a delta, creating a material risk of accidental stock distortion.

**Approach:** Remove every path that can create a new `stock_removed` event while preserving full read, projection, export, and recovery compatibility for historical events already stored in databases and workbooks.

</frozen-after-approval>

## Implementation Notes

- Removed the inventory-correction card and rebalanced the remaining management cards to two columns.
- Removed the `/api/stock/remove` route and `InventoryService.removeStock`, eliminating production paths that create new `stock_removed` events.
- Preserved `stock_removed` in event types, projections, ledger labels, migrations, workbook recovery, and reports so historical records remain truthful and portable.
- Updated domain, API, workbook, recovery, report, and UI tests. Historical-compatibility fixtures now insert legacy events directly rather than exercising a production command.
- Verification passed: Prettier, ESLint, client/server TypeScript checks, 63 non-integration tests, 18 integration tests, and the production build. The integration suite required a permitted local listener after the sandbox rejected socket binding with `EPERM`.
- Blind review removed stale navigation and README promises, and centralized historical-removal setup in a named test helper. All 81 tests and the production build passed again after those patches.

## Review Triage Log

- `false` — The missing replacement reconciliation workflow is the requested outcome: the frozen intent explicitly retires every production path that creates `stock_removed`; adding a replacement would reverse that decision.
- `low`, patched — The management navigation still promised adjustments after the action disappeared; it now names stock receipt and damaged-stock handling only.
- `low`, patched — The README still documented compensating stock corrections; the admin capability list now matches the active command surface.
- `low`, patched — Three suites duplicated raw historical-event SQL; a single test-only `recordHistoricalStockRemoval` helper now makes the backward-compatibility fixture explicit and contains schema coupling.
