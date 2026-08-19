- source_spec: none
  summary: Add standardized catalog XLSX/CSV import and export for items, borrowers, and locations.
  evidence: Catalog files support spreadsheet analysis and editing, with imported changes recorded as admin events. Split from the initial core workflow so editable spreadsheet interchange can be reviewed and shipped independently after the local transaction model is proven.

- source_spec: none
  summary: Add whole-database XLSX import and export for portable backup and recovery.
  evidence: Whole-database files include the immutable ledger and history and restore by atomically replacing the database; they are not an ordinary editing surface and do not support partial import, merge, or selective history replacement. Split from catalog interchange so its disaster-recovery semantics can be designed and validated independently.

- source_spec: none
  summary: Add opportunistic encrypted cloud backup and full-database disaster recovery.
  evidence: Split from the initial core workflow because remote backup infrastructure is independent of front-desk checkout and return behavior.

- source_spec: none
  summary: Add operational reports for outstanding loans, daily activity, inventory by location, damage, and loss.
  evidence: Split from the initial core workflow because reporting can be derived from the stable ledger after the core transaction paths are validated.
