---
title: 'Spin up sample development instance'
type: 'chore'
created: '2026-09-03'
status: 'done'
route: 'one-shot'
---

# Spin up sample development instance

## Intent

**Problem:** The application needed a quickly accessible development instance with enough representative inventory state to exercise its main screens and lifecycle cases.

**Approach:** Create an isolated disposable SQLite database outside the repository, populate it through the real inventory domain service, and run the existing development servers against it without touching persisted project data or changing application code.

## Suggested Review Order

- Confirm the run is disposable, representative, and leaves application code unchanged.
  [`spec-spin-up-sample-dev-instance.md:1`](spec-spin-up-sample-dev-instance.md#L1)
