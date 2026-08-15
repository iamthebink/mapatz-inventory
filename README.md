# Mapatz Inventory

Local-first Hebrew front-desk inventory for consumables and quantity-based equipment loans. The SQLite event ledger is append-only; current availability, outstanding loans, lost quantities, and damaged stock are derived from it.

## Run with Docker

Set non-default bootstrap passwords, create a persistent data directory, then run:

```sh
docker build -t mapatz-inventory .
docker run --rm -p 3000:3000 \
  -e ADMIN_PASSWORD='replace-with-a-strong-password' \
  -e OPERATOR_PASSWORD='replace-with-a-different-password' \
  -v "$(pwd)/data:/data" mapatz-inventory
```

Open `http://localhost:3000`. The application requires no internet connection at runtime. Passwords are used only to initialize missing credentials and are persisted as salted scrypt hashes; admins can replace them from the management screen. Existing persisted credentials are not overwritten on restart.

## Develop and verify

Node 22.12+ and pnpm are required because the application uses Node's built-in SQLite module and the locked Vite toolchain requires Node 22.12 or newer.

```sh
pnpm install
pnpm dev
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Development data defaults to `./data/inventory.sqlite`. A fresh database requires explicit, non-empty `ADMIN_PASSWORD` and `OPERATOR_PASSWORD` values; startup fails with a clear error if either bootstrap credential is absent. Once both salted hashes exist, later restarts use the persisted credentials and ignore changed or absent bootstrap environment values. Set `DATA_DIR` and `PORT` as needed; `.env.example` lists all environment keys without shipping known passwords.

## Roles and operating model

- Guests can inspect every screen but cannot mutate data.
- Operators can create borrowers, issue consumables, check out non-consumables, and record usable or damaged returns.
- Admins can additionally manage catalogs and passwords, correct stock through compensating events, archive inactive records, resolve damage, and mark or unmark lost equipment.
- Admin and operator privileges expire after 60 and 300 idle seconds respectively. The UI warns during the last ten seconds, while the server independently enforces the deadline.

Item codes begin at 100 and never repeat. Item aliases, names, and codes are searchable; archived records disappear from operating pickers but remain in history. The database prevents event updates or deletion, negative availability, over-return, and archiving records with unresolved equipment.

## Deliberately deferred

This slice does not import or export spreadsheets, generate reports, automate cloud recovery, track individual serialized instances or opened lots, record operator identity, or infer laptop lock state. The normalized catalog plus append-only event schema is intended to support later import/export, reporting, and backup adapters without replacing the ledger.
