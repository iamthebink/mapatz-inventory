CREATE TABLE item_state (
  item_id INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  borrowed INTEGER NOT NULL DEFAULT 0 CHECK (borrowed >= 0),
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

CREATE TABLE item_location_balances (
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  location_id INTEGER NOT NULL REFERENCES locations(id),
  available INTEGER NOT NULL DEFAULT 0 CHECK (available BETWEEN 0 AND 9007199254740991),
  damaged INTEGER NOT NULL DEFAULT 0 CHECK (damaged BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY(item_id,location_id)
);
CREATE TABLE inventory_settings (
  singleton INTEGER PRIMARY KEY CHECK (singleton=1),
  default_location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL
);
INSERT INTO inventory_settings(singleton,default_location_id) VALUES (1,NULL);
