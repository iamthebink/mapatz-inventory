# Mapatz Inventory

Local-first Hebrew front-desk inventory for consumables and quantity-based equipment loans. The SQLite event ledger is append-only; current availability, outstanding loans, lost quantities, and damaged stock are derived from it.

## Run with Docker

Set an admin bootstrap password, create a persistent data directory, then run:

```sh
docker build -t mapatz-inventory .
docker run --rm -p 3000:3000 \
  -e ADMIN_PASSWORD='choose-a-password' \
  -v "$(pwd)/data:/data" mapatz-inventory
```

Open `http://localhost:3000`. The application requires no internet connection at runtime. The admin password is used only to initialize a missing credential and is persisted as a salted scrypt hash; admins can replace it from the management screen. An existing persisted credential is not overwritten on restart.

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

Development data defaults to `./data/inventory.sqlite`. A fresh database requires an explicit, non-empty `ADMIN_PASSWORD`; startup fails with a clear error if it is absent. Once its salted hash exists, later restarts use the persisted credential and ignore a changed or absent bootstrap environment value. Set `DATA_DIR` and `PORT` as needed; `.env.example` lists all environment keys without shipping a known password.

## Roles and operating model

- Non-admin users can immediately create borrowers, issue consumables, check out non-consumables, and record usable or damaged returns without a password.
- Admins can additionally manage catalogs and the admin password, receive stock, archive inactive records, resolve damage, and mark or unmark lost equipment.
- Admin privileges return to non-admin after ten idle minutes. The UI warns during the last ten seconds, while the server independently enforces the deadline. Non-admin access does not expire.
- The admin password is an accidental-action barrier for a trusted operating environment, not a security boundary against malicious local or network access.

Item codes begin at 100 and never repeat. Item aliases, names, and codes are searchable; archived records disappear from operating pickers but remain in history. The database prevents event updates or deletion, negative availability, over-return, and archiving records with unresolved equipment.

## Deliberately deferred

This slice does not import or export spreadsheets, generate reports, automate cloud recovery, track individual serialized instances or opened lots, record operator identity, or infer laptop lock state. The normalized catalog plus append-only event schema is intended to support later import/export, reporting, and backup adapters without replacing the ledger.
