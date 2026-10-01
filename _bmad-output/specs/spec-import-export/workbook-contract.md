# Workbook Contract

## Scope and Payload

One XLSX workbook contains two separate import payloads and two reports. The reset area contains editable, state-agnostic item totals for next-year planning. The recovery area contains authoritative inventory history and state, including loans, damage, and loss. Credentials and application configuration are absent from export and are never imported.

| Logical content | Reset | Recovery |
| --- | --- | --- |
| Required workbook structure | Validate sheets, columns, references, and values before mutation | Validate sheets, columns, references, and values before mutation |
| Items, aliases, locations, and archive metadata | Location records contain name and archived status; generate location IDs | Preserve location name/archive values and relationships while generating location IDs |
| Quantity per item | Editable state-agnostic total | Preserve captured stock and every state component |
| Starting-stock baseline | Fix at reset using the edited total | Preserve original baseline and activity breakdown |
| Borrowers | Do not carry forward | Preserve all source records and references |
| Complete activity ledger | Do not carry forward | Preserve events, identifiers, timestamps, and relationships |
| Current loans, damage, and loss | Ignore state categories; import only the edited total | Restore authoritative item and loan quantities faithfully |
| Identity/allocation state | Generate fresh internal identities; reset rows have no item identity column | Generate fresh internal item/location/borrower IDs and remap relationships; retain durable identity high-water marks and event IDs |
| Credentials/configuration | Excluded; destination unchanged | Excluded; destination unchanged |

The starting-stock baseline is inventory business data, not excluded application configuration.

## Payload Separation

- Reset reads only the editable totals area and its catalog fields. Recovery history and state cannot change the reset result.
- Recovery reads the authoritative recovery area and ignores edits made to reset totals.
- The reset area is a planning surface: administrators may add or remove item types and change totals without recording those changes as application transactions.
- The recovery area is designed to remain export-generated. Even if its origin cannot be proven, it must be complete and satisfy all invariants of a functional instance.
- Reset creates no borrowed, damaged, or lost state. The exported total initially rolls those units into one number, which the administrator may edit into the chosen next-year baseline.
- Recovery restores borrowed, damaged, and lost quantities exactly as captured.
- Item rows contain location names. Neither import payload contains numeric location IDs.

## Reset Total Initialization

- For non-consumable equipment, initialize the editable total as available + currently checked out + unresolved damaged + lost.
- “Currently checked out” excludes quantities separately classified as lost, so lost equipment is counted once.
- For consumables, initialize the editable total from remaining available stock; consumables have no checkout, damage, or loss states.
- Stock removed, written off, or issued is no longer in a current inventory state and is excluded.
- The administrator may edit any initialized total before reset; the edited value becomes starting stock.

## Confirmed Import Rules

- Export and both import modes are admin-only, enforced at the server boundary.
- Show destructive-action confirmation before every import attempt; proceeding requires explicit confirmation, and cancellation leaves data unchanged.
- Reset replaces operational and catalog data from the editable totals area; recovery replaces them from the complete captured inventory-domain state.
- Validate all data required for the selected mode before committing an atomic replacement; no partial merge or selective history replacement is supported.
- Reset contains no item identity column; allocate internal IDs for destination records.
- Recovery requires positive unique technical Item ID values in Recovery Items and matching Item ID references in Recovery Events and Recovery Loans. These connect workbook records; destination IDs are freshly allocated and all relationships are remapped.
- Recovery validates catalogs, borrowers, event chronology and references, authoritative item/loan quantities, and matching loan aggregates before atomic replacement. Captured item/loan state is restored directly; ledger replay does not reconstruct current balances.
- A replacement machine needs its own credentials/configuration before use; these do not come from the workbook.
- Defaults apply only to blank or omitted optional reset fields. Explicit invalid values reject the entire import before mutation.
- A supplied item location must reference an imported location; a supplied lot size must be a positive integer for a consumable; supplied archive values must be valid booleans.
- Location names must be unique. Both import modes generate numeric location IDs and connect items by resolving their location names; an unknown or ambiguous name rejects the import.

## Confirmed Optional Item Defaults

These defaults apply to blank or omitted optional reset fields. Export carries actual source values; recovery preserves them.

| Item field | Confirmed reset default |
| --- | --- |
| Location | Unassigned |
| Aliases | Empty list |
| Lot size | Unset |
| Archived | False (active) |

## Confirmed Required Item Fields

| Item field | Confirmed reset rule |
| --- | --- |
| Name | Required nonblank text; no default. |
| Kind | Required `consumable`, `non_consumable`, or `camp_equipment` value; no guessed default. |
| Item total | Required nonnegative integer, including explicit zero; blank is rejected. The edited total becomes new starting stock. |

## Reset Catalog Rules

All catalog fields are present in standard export with their actual values, including archived records. The required fields and four blank-value defaults above are confirmed.

Reset item rows have no identity field. Recovery Item ID is a technical workbook relationship key, never an operator identifier or a promise of destination identity. Names remain unique presentation/search keys.

| Location field | Confirmed workbook rule |
| --- | --- |
| Name | Confirmed required, nonblank, and unique; no default. Used as the item-location reference. |
| Archived | Optional; blank means false (active). This is the only other workbook location field. |

Numeric location IDs and the current location text code are absent from export. Numeric IDs are regenerated during both imports; the implementation may remove or internally generate the code. Reset rows do not need hidden item database IDs or timestamps. Recovery preserves business data, event IDs, timestamps, order, and semantic relationships while remapping item IDs. Durable identity allocation, ledger epoch rotation, revision checks, and command receipts prevent old actions from addressing replacement records. Borrower metadata is preserved in recovery data and has no reset defaults because reset does not import borrowers.

Confirmed quantity rule: the workbook provides a separate totals-only reset area initialized from all current item-state buckets without double-counting. The administrator can edit it. Each imported total becomes new starting stock, with no inherited loan, damage, or loss category. Recovery uses its separate detailed payload and preserves all those states.

Reset can proceed even when the export-time recovery state contains borrowed, damaged, or lost equipment. Those categories inform the initial rolled-up total but do not become reset preconditions or imported state.

## Reports

### Unresolved Damage

Include only equipment with unresolved damage at the export point. Quantities exclude damage already repaired or written off. Columns are item name, location, and unresolved damaged quantity. Neither report displays or exports an item identifier. Historical damage events still belong in recovery data.

### Consumables Usage

Include every consumable with these four business measures:

| Measure | Meaning |
| --- | --- |
| Start of cycle stock | Starting quantity established by reset, preserved through recovery. |
| Added during cycle | Stock additions after the baseline through export. |
| Usage | Issued quantity after the baseline through export. |
| Left | Available quantity at export, including stock corrections. |

Usage never absorbs stock removals/corrections. Under the existing ledger, remaining stock equals opening stock plus subsequent additions minus issued quantity minus stock removals. For example, opening 100, added 20, issued 30, and a downward correction of 5 yields a report of 100 / 20 / 30 / 85. The correction remains explainable in the exported ledger; a fifth business measure is not required by this spec.

### Baseline Semantics — Confirmed

Reset starts a new reporting cycle: the edited item total becomes starting stock, and prior additions and usage are not inherited. Every receipt after reset counts as an addition, including during planning. Recovery preserves the original baseline and activity history.

For an export containing starting stock 100, added 20, issued 0, and remaining 120:

| Import mode | Starting stock after import | Added | Issued | Remaining |
| --- | --- | --- | --- | --- |
| Reset | 120 | 0 | 0 | 120 |
| Recovery | 100 | 20 | 0 | 120 |

## Existing Domain Evidence

The schema stores numeric item IDs for relationships and has no item code or code sequence. Location codes remain unchanged. Unique catalog names and aliases identify items to operators. Authoritative item/loan state and cycle baselines are stored alongside the immutable ledger. Recovery State stores Revision, Next Item ID, Next Borrower ID, Next Location ID, and Next Event ID; it has no Next Item Code field.

Recovery preserves authoritative item and loan state, baselines, and ledger chronology/references so subsequent operations remain valid. Because credentials coexist with inventory in the database, a raw database replacement would violate the confirmed preservation boundary.
