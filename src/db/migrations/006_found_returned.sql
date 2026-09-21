DROP TRIGGER inventory_events_no_update;
DROP TRIGGER inventory_events_no_delete;
CREATE TABLE inventory_events_new (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN (
    'stock_added','stock_removed','issued','checked_out','returned_usable',
    'returned_damaged','marked_lost','found_returned','repaired','written_off'
  )),
  item_id INTEGER NOT NULL REFERENCES items(id),
  borrower_id INTEGER REFERENCES borrowers(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  related_event_id INTEGER REFERENCES inventory_events_new(id),
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((kind = 'checked_out' AND borrower_id IS NOT NULL) OR (kind <> 'checked_out'))
);
INSERT INTO inventory_events_new(id, kind, item_id, borrower_id, quantity, related_event_id, note, created_at)
SELECT id, kind, item_id, borrower_id, quantity, related_event_id, note, created_at FROM inventory_events;

DROP TABLE inventory_events;
ALTER TABLE inventory_events_new RENAME TO inventory_events;
CREATE INDEX events_item_idx ON inventory_events(item_id);
CREATE INDEX events_borrower_idx ON inventory_events(borrower_id);

CREATE TRIGGER inventory_events_no_update
BEFORE UPDATE ON inventory_events
WHEN (SELECT enabled FROM inventory_replacement_guard WHERE singleton = 1) = 0
BEGIN SELECT RAISE(ABORT, 'inventory ledger is immutable'); END;

CREATE TRIGGER inventory_events_no_delete
BEFORE DELETE ON inventory_events
WHEN (SELECT enabled FROM inventory_replacement_guard WHERE singleton = 1) = 0
BEGIN SELECT RAISE(ABORT, 'inventory ledger is immutable'); END;

CREATE INDEX events_related_kind_idx ON inventory_events(related_event_id, kind);
CREATE INDEX events_borrower_item_kind_created_id_idx
ON inventory_events(borrower_id, item_id, kind, created_at, id);
