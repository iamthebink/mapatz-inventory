CREATE TABLE items_new (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  kind TEXT NOT NULL CHECK (kind IN ('consumable','non_consumable','camp_equipment')),
  lot_size INTEGER CHECK (lot_size IS NULL OR lot_size > 0),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO items_new(id, name, kind, lot_size, archived, created_at)
SELECT id, name, kind, lot_size, archived, created_at FROM items;

DROP TABLE items;
ALTER TABLE items_new RENAME TO items;
