---
title: 'Clarify deferred spreadsheet scope'
type: 'chore'
created: '2026-08-20'
status: 'done'
route: 'one-shot'
---

# Clarify deferred spreadsheet scope

## Intent

**Problem:** The deferred-work backlog preserved editable catalog spreadsheet interchange but did not explicitly preserve the separately agreed whole-database XLSX import/export scope or its immutable-history boundary.

**Approach:** Record catalog interchange and whole-database backup/restore as distinct deferred work items, clarifying that catalog imports create admin events while whole-database restores atomically replace the database without partial merging or selective ledger editing.

## Suggested Review Order

- Start with editable catalog interchange and its event-recording boundary.
  [`deferred-work.md:2`](deferred-work.md#L2)

- Confirm whole-database XLSX remains recovery-only and preserves immutable history.
  [`deferred-work.md:6`](deferred-work.md#L6)
