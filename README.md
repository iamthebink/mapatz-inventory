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

Node 22.16+ and pnpm are required because the application uses Node's built-in SQLite module, including transaction-state inspection, and the locked Vite toolchain requires a current Node 22 release.

```sh
pnpm install
pnpm exec playwright install chromium
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
```

Run `pnpm dev` separately when you want the local development server and Vite watcher.

Development data defaults to `./data/inventory.sqlite`. A fresh database requires an explicit, non-empty `ADMIN_PASSWORD`; startup fails with a clear error if it is absent. Once its salted hash exists, later restarts use the persisted credential and ignore a changed or absent bootstrap environment value. Set `DATA_DIR` and `PORT` as needed; `.env.example` lists all environment keys without shipping a known password.

The browser suite starts a local application server backed by a unique temporary SQLite database, seeds its own deterministic records, and removes that database when it exits. It does not use or mutate `./data` and requires no network access after Chromium is installed.

## Roles and operating model

- Non-admin users can immediately create borrowers, issue consumables, and use the borrower desk to borrow non-consumables or record usable and damaged returns without a password. The borrower desk is the single borrowing and return path.
- Admins can additionally manage catalogs and the admin password, receive stock, archive inactive records, resolve damage, and mark or unmark lost equipment.
- Admin privileges return to non-admin after ten idle minutes. The UI warns during the last ten seconds, while the server independently enforces the deadline. Non-admin access does not expire.
- The admin password is an accidental-action barrier for a trusted operating environment, not a security boundary against malicious local or network access.

Item codes begin at 100 and never repeat. Item aliases, names, and codes are searchable; archived records disappear from operating pickers but remain in history. The database prevents event updates or deletion, negative availability, over-return, and archiving records with unresolved equipment.

## Deliberately deferred

This slice does not import or export spreadsheets, generate reports, automate cloud recovery, track individual serialized instances or opened lots, record operator identity, or infer laptop lock state. The normalized catalog plus append-only event schema is intended to support later import/export, reporting, and backup adapters without replacing the ledger.
