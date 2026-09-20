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

## Desktop installation and camp use

Desktop builds are unsigned. Download the Windows x64 installer or the Mac ZIP matching the laptop (Apple Silicon arm64 or Intel x64). Windows: run the installer, then open Mapatz Inventory. Windows SmartScreen or organizational policy may block unsigned software; use only artifacts supplied by your trusted camp maintainer, and ask that maintainer for assistance if blocked. Mac: extract the ZIP and move Mapatz Inventory to Applications. Gatekeeper may require an explicit approval in System Settings → Privacy & Security; organizational policy can prohibit unsigned applications. There is no paid signing or automatic updater.

The app works offline without Node, Git, Docker, or a terminal. On first launch, choose an admin password (8–256 characters). Closing setup cancels safely; subsequent launches keep the credential and start as an operator. A second launch focuses the existing window. This application supports one local laptop and one database only.

Data lives outside the installation: `%APPDATA%/Mapatz Inventory` on Windows and `~/Library/Application Support/Mapatz Inventory` on Mac. Keep the **entire** directory when upgrading: it includes `inventory.sqlite`, the stable-origin `profile.json`, Chromium recovery storage, `backups/` and `desktop.log`. Never delete the profile to solve a startup failure. With the app completely closed, copy the entire profile to another disk for a recoverable backup. Before pending schema migrations, the app also creates a consistent SQLite backup in `backups/`. A newer database schema blocks an older app safely.

For a manual update, finish or resolve pending operations, quit, back up the whole profile, and replace the application/install the new version. Do not uninstall or delete user data. Native workbook export reports success only after the file has been written; cancelling the save dialog is neutral. Inventory workbook export, reset/recovery import, and borrower spreadsheet import are supported. Pending commands retain their original keys across restart and must be reconciled before new work.

Startup failures offer retry/quit and identify `desktop.log`. Send that log and the application version to your camp maintainer; do not share a database containing personal records casually. Port conflicts require closing the conflicting process rather than changing the saved port, because browser recovery belongs to that origin.

## Desktop build and verification

Use Node 24 LTS for desktop builds (the host Node 26 runtime silently failed during Forge archive extraction). Run `pnpm desktop:package`, `pnpm test:desktop`, and `pnpm desktop:make` on each target platform. Forge stages production dependencies and assets into `desktop-stage` and produces unsigned artifacts in `desktop-stage/out/make`. CI covers Windows x64 and Mac arm64/x64, including installed Windows launch. Every pushed tag starts release validation; stable version tags such as `0.1.2` or `v0.1.2` are published after successful regression checks and desktop verification on all targets; manual workflow dispatch with an existing tag is also available. The Windows installer and Mac ZIPs are attached as downloadable GitHub Release assets. `MAPATZ_PROFILE` isolates test profiles and `MAPATZ_EXECUTABLE` selects an installed artifact for verification.

Automated results do not replace a supervised rehearsal on the actual Windows camp laptop: test SmartScreen/policy, native save dialogs, Hebrew file paths, display scaling, sleep/resume, offline launch, and a manual update with the full profile preserved. This rehearsal must be reported separately; it has not been performed by adding these workflows.

### Releasing a field update

Commit and push the code, then push a stable version tag (for example `git tag 0.1.2` and `git push origin 0.1.2`). The tag is the release version: no version-bump commit is needed. CI validates it first, pins the source commit, and stamps all three package version fields in each job's temporary checkout before testing and packaging. It never commits these values or moves the tag. Optional `v` prefixes are removed from the packaged version; prerelease/build suffixes and non-version tags are rejected before packaging. Branch builds keep the checked-in development version, and tag pushes run only the release pipeline.

To reproduce release packaging locally in a disposable checkout, run `node scripts/desktop-version.mjs stamp 0.1.2` before the normal build/test/make commands. This changes that checkout's package files; do not commit the generated version changes. The field operator finishes pending work, quits, backs up the whole profile, and runs the new Setup.exe under the same Windows account without uninstalling. Updates remain manual.

CI and release publication require a real Windows installer upgrade from the checksum-pinned published `0.1.0` baseline to the candidate. A separate clean hosted runner installs both Setup packages in sequence using the default profile. It verifies the new version, original password, profile/origin, localStorage, inventory, borrower and ledger records, idempotent command replay, and a return that survives another restart. Evidence is uploaded as `windows-upgrade-evidence`. The candidate must have a newer stable version than the baseline; update the pinned baseline deliberately when changing the supported upgrade floor. This does not exercise schema migration unless the candidate includes one.

Once the workflow is on the default branch, for test-harness debugging manually dispatch **Windows installer upgrade** with the completed CI run ID and its Windows artifact name. Supply the candidate version for a tag-stamped installer; leave it empty for a development build. This reuses the installer and does not publish a release. The normal release gate always uses its own verified artifact.

The dedicated `playwright.upgrade.config.ts` suite is restricted to clean GitHub-hosted Windows runners because it installs software and uses the normal Windows profile. The ordinary `test:desktop` suite excludes it.
