CREATE TABLE radio_fleet (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  count INTEGER NOT NULL DEFAULT 40 CHECK (count >= 0),
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0)
);
INSERT INTO radio_fleet(singleton, generation) VALUES (1, 1);

CREATE TABLE radios (
  number INTEGER PRIMARY KEY CHECK (number > 0),
  holder TEXT NOT NULL CHECK (length(trim(holder)) > 0),
  team TEXT NOT NULL DEFAULT '',
  lost INTEGER NOT NULL DEFAULT 0 CHECK (lost IN (0, 1))
);

WITH RECURSIVE numbers(number) AS (
  SELECT 1
  UNION ALL
  SELECT number + 1 FROM numbers
  WHERE number < (SELECT count FROM radio_fleet WHERE singleton = 1)
)
INSERT INTO radios(number, holder)
SELECT number, 'צוללת' FROM numbers;
