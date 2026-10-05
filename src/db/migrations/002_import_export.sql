DROP TRIGGER IF EXISTS inventory_events_no_update;
DROP TRIGGER IF EXISTS inventory_events_no_delete;
DROP INDEX IF EXISTS events_item_idx;
DROP INDEX IF EXISTS events_borrower_idx;

CREATE TABLE locations_new (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL COLLATE NOCASE UNIQUE,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(trim(name)) BETWEEN 1 AND 100),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1))
);
INSERT INTO locations_new(id, code, name, archived)
SELECT id, code, name, archived FROM locations;

CREATE TABLE items_new (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  kind TEXT NOT NULL CHECK (kind IN ('consumable','non_consumable')),
  lot_size INTEGER CHECK (lot_size IS NULL OR lot_size > 0),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO items_new(id, name, kind, lot_size, archived, created_at)
SELECT id, name, kind, lot_size, archived, created_at FROM items;

CREATE TABLE item_aliases_new (
  item_id INTEGER NOT NULL REFERENCES items_new(id) ON DELETE CASCADE,
  alias TEXT NOT NULL COLLATE NOCASE CHECK (length(trim(alias)) BETWEEN 1 AND 100),
  PRIMARY KEY(item_id, alias)
);
INSERT INTO item_aliases_new(item_id, alias) SELECT item_id, alias FROM item_aliases;

CREATE TABLE inventory_events_new (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN (
    'stock_added','stock_removed','issued','checked_out','returned_usable',
    'returned_damaged','marked_lost','unmarked_lost','repaired','written_off'
  )),
  item_id INTEGER NOT NULL REFERENCES items_new(id),
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
DROP TABLE item_aliases;
DROP TABLE items;
DROP TABLE locations;
ALTER TABLE locations_new RENAME TO locations;
ALTER TABLE items_new RENAME TO items;
ALTER TABLE item_aliases_new RENAME TO item_aliases;
ALTER TABLE inventory_events_new RENAME TO inventory_events;

CREATE INDEX events_item_idx ON inventory_events(item_id);
CREATE INDEX events_borrower_idx ON inventory_events(borrower_id);

CREATE TABLE inventory_replacement_guard (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1))
);
INSERT INTO inventory_replacement_guard(singleton, enabled) VALUES (1, 0);

CREATE TRIGGER inventory_events_no_update
BEFORE UPDATE ON inventory_events
WHEN (SELECT enabled FROM inventory_replacement_guard WHERE singleton = 1) = 0
BEGIN SELECT RAISE(ABORT, 'inventory ledger is immutable'); END;

CREATE TRIGGER inventory_events_no_delete
BEFORE DELETE ON inventory_events
WHEN (SELECT enabled FROM inventory_replacement_guard WHERE singleton = 1) = 0
BEGIN SELECT RAISE(ABORT, 'inventory ledger is immutable'); END;

CREATE TABLE inventory_baselines (
  item_id INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL CHECK (quantity >= 0),
  through_event_id INTEGER NOT NULL DEFAULT 0 CHECK (through_event_id >= 0),
  established_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO inventory_baselines(item_id, quantity, through_event_id)
SELECT i.id,
  CASE WHEN i.kind = 'consumable' THEN
    COALESCE((SELECT SUM(CASE e.kind
      WHEN 'stock_added' THEN e.quantity WHEN 'returned_usable' THEN e.quantity WHEN 'repaired' THEN e.quantity
      WHEN 'stock_removed' THEN -e.quantity WHEN 'issued' THEN -e.quantity WHEN 'checked_out' THEN -e.quantity ELSE 0 END)
      FROM inventory_events e WHERE e.item_id = i.id), 0)
  ELSE
    COALESCE((SELECT SUM(CASE e.kind
      WHEN 'stock_added' THEN e.quantity WHEN 'returned_usable' THEN e.quantity WHEN 'repaired' THEN e.quantity
      WHEN 'stock_removed' THEN -e.quantity WHEN 'issued' THEN -e.quantity WHEN 'checked_out' THEN -e.quantity ELSE 0 END)
      FROM inventory_events e WHERE e.item_id = i.id), 0)
    + COALESCE((SELECT SUM(CASE e.kind WHEN 'returned_damaged' THEN e.quantity WHEN 'repaired' THEN -e.quantity WHEN 'written_off' THEN -e.quantity ELSE 0 END)
      FROM inventory_events e WHERE e.item_id = i.id), 0)
    + COALESCE((SELECT SUM(e.quantity - COALESCE((SELECT SUM(CASE x.kind
        WHEN 'returned_usable' THEN x.quantity WHEN 'returned_damaged' THEN x.quantity
        WHEN 'marked_lost' THEN x.quantity WHEN 'unmarked_lost' THEN -x.quantity ELSE 0 END)
      FROM inventory_events x WHERE x.related_event_id = e.id), 0))
      FROM inventory_events e WHERE e.item_id = i.id AND e.kind = 'checked_out'), 0)
    + COALESCE((SELECT SUM(CASE e.kind WHEN 'marked_lost' THEN e.quantity WHEN 'unmarked_lost' THEN -e.quantity ELSE 0 END)
      FROM inventory_events e WHERE e.item_id = i.id), 0)
  END,
  COALESCE((SELECT MAX(e.id) FROM inventory_events e WHERE e.item_id = i.id), 0)
FROM items i;
