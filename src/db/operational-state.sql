CREATE TABLE item_state (
  item_id INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  available INTEGER NOT NULL DEFAULT 0 CHECK (available >= 0),
  borrowed INTEGER NOT NULL DEFAULT 0 CHECK (borrowed >= 0),
  damaged INTEGER NOT NULL DEFAULT 0 CHECK (damaged >= 0),
  lost INTEGER NOT NULL DEFAULT 0 CHECK (lost >= 0),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)
);

CREATE TABLE loan_state (
  checkout_id INTEGER PRIMARY KEY REFERENCES inventory_events(id),
  item_id INTEGER NOT NULL REFERENCES items(id),
  borrower_id INTEGER NOT NULL REFERENCES borrowers(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  created_at TEXT NOT NULL,
  outstanding INTEGER NOT NULL CHECK (outstanding >= 0),
  lost INTEGER NOT NULL CHECK (lost >= 0),
  CHECK (outstanding + lost <= quantity)
);
CREATE INDEX loan_state_borrower_item_order
  ON loan_state(borrower_id,item_id,created_at,checkout_id);

CREATE TABLE state_clock (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision INTEGER NOT NULL CHECK (revision >= 0)
);
INSERT INTO state_clock(singleton,revision) VALUES (1,0);
