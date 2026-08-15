- source_spec: none
  summary: Add standardized catalog XLSX/CSV import and export for items, borrowers, and locations.
  evidence: Split from the initial core workflow so spreadsheet interoperability can be reviewed and shipped independently after the local transaction model is proven.

- source_spec: none
  summary: Add opportunistic encrypted cloud backup and full-database disaster recovery.
  evidence: Split from the initial core workflow because remote backup infrastructure is independent of front-desk checkout and return behavior.

- source_spec: none
  summary: Add operational reports for outstanding loans, daily activity, inventory by location, damage, and loss.
  evidence: Split from the initial core workflow because reporting can be derived from the stable ledger after the core transaction paths are validated.
