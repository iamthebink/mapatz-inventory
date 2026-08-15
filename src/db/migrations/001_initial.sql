PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS code_sequence (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  next_code INTEGER NOT NULL CHECK (next_code >= 100)
);
INSERT OR IGNORE INTO code_sequence(singleton, next_code) VALUES (1, 100);

CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL COLLATE NOCASE UNIQUE,
  name TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1))
);
INSERT OR IGNORE INTO locations(code, name) VALUES
  ('monster', 'מפלצת'), ('submarine', 'צוללת'), ('kabira', 'כבירא');

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY,
  code INTEGER NOT NULL UNIQUE CHECK (code >= 100),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  kind TEXT NOT NULL CHECK (kind IN ('consumable','non_consumable')),
  lot_size INTEGER CHECK (lot_size IS NULL OR lot_size > 0),
  location_id INTEGER REFERENCES locations(id),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS item_aliases (
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  alias TEXT NOT NULL COLLATE NOCASE CHECK (length(trim(alias)) BETWEEN 1 AND 100),
  PRIMARY KEY(item_id, alias)
);
CREATE TABLE IF NOT EXISTS borrowers (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(trim(username)) BETWEEN 2 AND 40),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  contact TEXT NOT NULL DEFAULT '' CHECK (length(contact) <= 500),
  type TEXT NOT NULL CHECK (type IN ('individual','camp_organization','other')),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS inventory_events (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN (
    'stock_added','stock_removed','issued','checked_out','returned_usable',
    'returned_damaged','marked_lost','unmarked_lost','repaired','written_off'
  )),
  item_id INTEGER NOT NULL REFERENCES items(id),
  borrower_id INTEGER REFERENCES borrowers(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  related_event_id INTEGER REFERENCES inventory_events(id),
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((kind = 'checked_out' AND borrower_id IS NOT NULL) OR (kind <> 'checked_out'))
);
CREATE INDEX IF NOT EXISTS events_item_idx ON inventory_events(item_id);
CREATE INDEX IF NOT EXISTS events_borrower_idx ON inventory_events(borrower_id);

CREATE TRIGGER IF NOT EXISTS inventory_events_no_update
BEFORE UPDATE ON inventory_events BEGIN SELECT RAISE(ABORT, 'inventory ledger is immutable'); END;
CREATE TRIGGER IF NOT EXISTS inventory_events_no_delete
BEFORE DELETE ON inventory_events BEGIN SELECT RAISE(ABORT, 'inventory ledger is immutable'); END;

CREATE TABLE IF NOT EXISTS credentials (
  role TEXT PRIMARY KEY CHECK (role IN ('operator','admin')),
  salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
