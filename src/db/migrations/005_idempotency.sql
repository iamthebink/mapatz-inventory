ALTER TABLE inventory_replacement_guard
ADD COLUMN ledger_epoch INTEGER NOT NULL DEFAULT 1;

CREATE TABLE idempotency_receipts (
  key TEXT NOT NULL PRIMARY KEY,
  command_kind TEXT NOT NULL CHECK (command_kind IN ('borrower_operation','borrower_create')),
  ledger_epoch INTEGER NOT NULL,
  contract_version INTEGER NOT NULL,
  request_hash TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('committed','rejected')),
  subject_id INTEGER,
  result_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX events_related_kind_idx ON inventory_events(related_event_id, kind);
CREATE TABLE inventory_command_receipts (
  key TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX events_borrower_item_kind_created_id_idx
ON inventory_events(borrower_id, item_id, kind, created_at, id);
