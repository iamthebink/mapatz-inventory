CREATE TABLE credentials_admin_only (
  role TEXT PRIMARY KEY CHECK (role = 'admin'),
  salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO credentials_admin_only(role, salt, password_hash, updated_at)
SELECT role, salt, password_hash, updated_at
FROM credentials
WHERE role = 'admin';

DROP TABLE credentials;
ALTER TABLE credentials_admin_only RENAME TO credentials;
