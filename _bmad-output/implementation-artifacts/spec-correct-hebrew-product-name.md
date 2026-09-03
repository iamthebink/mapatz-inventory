---
title: 'Correct Hebrew product name to מפ״צ'
type: 'chore'
created: '2026-09-03'
status: 'done'
route: 'one-shot'
---

# Correct Hebrew product name to מפ״צ

## Intent

**Problem:** The browser title and primary application heading use an incorrect final letter in the Hebrew product name.

**Approach:** Replace every repository occurrence of that Hebrew spelling with the canonical `מפ״צ` while leaving unrelated Hebrew words and stable transliterated technical identifiers unchanged.

## Suggested Review Order

- Updates the primary visible product heading to the canonical spelling.
  [`App.tsx:670`](../../src/web/App.tsx#L670)

- Keeps the browser tab title consistent with the application heading.
  [`index.html:6`](../../index.html#L6)
