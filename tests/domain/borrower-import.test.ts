import { foundReturned } from '../helpers/found-returned.js';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type InventoryDatabase } from '../../src/db/database.js';
import { InventoryService } from '../../src/domain/inventory.js';
import {
  InventoryTransferService,
  validateRecoveryPayload,
} from '../../src/domain/import-export.js';
import { exportWorkbook, parseRecoveryWorkbook } from '../../src/io/workbook.js';
import type { BorrowerImportRow } from '../../src/contracts/borrower-import.js';
const databases: InventoryDatabase[] = [];
afterEach(() => {
  databases.splice(0).forEach((db) => db.close());
});
const row = (playaName: string, name = playaName): BorrowerImportRow => ({
  playaName,
  fullName: name,
  phoneNumber: '',
  campDepartment: '',
});
function fixture() {
  const db = openDatabase(':memory:');
  databases.push(db);
  const service = new InventoryService(db);
  const defaultLocation = service.listLocations().find((location) => location.code === 'monster')!;
  service.saveInventoryLocation({
    key: 'fixture-default',
    ledgerEpoch: service.inventoryEpoch(),
    locationId: defaultLocation.id,
    code: defaultLocation.code,
    name: defaultLocation.name,
    isDefault: true,
  });
  const retained = service.createBorrower(row('retained'));
  const removed = service.createBorrower(row('removed'));
  const item = service.createItem({
    name: 'Tent',
    kind: 'non_consumable',
    locationId: Number(
      (service.listLocations().find((l) => l.code === 'monster') ?? service.listLocations()[0])!.id,
    ),
  });
  service.addStock(
    item.id,
    10,
    '',
    Number(
      (service.listLocations().find((l) => l.code === 'monster') ?? service.listLocations()[0])!.id,
    ),
  );
  const retainedLoan = service.checkout(
    item.id,
    retained.id,
    2,
    '',
    Number(
      (service.listLocations().find((l) => l.code === 'monster') ?? service.listLocations()[0])!.id,
    ),
  );
  const removedLoan = service.checkout(
    item.id,
    removed.id,
    5,
    '',
    Number(
      (service.listLocations().find((l) => l.code === 'monster') ?? service.listLocations()[0])!.id,
    ),
  );
  service.markLost(removedLoan, 2, true);
  return { db, service, retained, removed, item, retainedLoan, removedLoan };
}
describe('atomic borrower imports', () => {
  it('merges normalized identities, preserves IDs/loans, and reactivates archives', () => {
    const { service, retained, removed, retainedLoan } = fixture();
    const archived = service.createBorrower(row('archived'));
    service.archiveBorrower(archived.id, true);
    const rows = [row('ＲＥＴＡＩＮＥＤ', 'retained'), row('archived'), row('new')];
    const preview = service.previewBorrowerImport(rows, 'merge');
    expect(preview.affected).toEqual([]);
    expect(service.importBorrowers(rows, 'merge', preview.confirmationToken)).toMatchObject({
      outcome: 'committed',
      added: 1,
      updated: 2,
      returned: 0,
    });
    expect(service.listBorrowers()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: retained.id, fullName: 'retained' }),
        expect.objectContaining({ id: archived.id, archived: false }),
        expect.objectContaining({ id: removed.id }),
      ]),
    );
    expect(service.listLoans()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ checkoutId: retainedLoan, outstanding: 2 }),
      ]),
    );
  });
  it('previews without mutation and returns only usable outstanding balances, preserving losses and recovery', async () => {
    const { db, service, retained, removed, item, retainedLoan, removedLoan } = fixture();
    const rows = [row('retained')];
    const before = service.listLedger();
    const preview = service.previewBorrowerImport(rows, 'replace');
    expect(service.listLedger()).toEqual(before);
    expect(preview.affected).toEqual([
      {
        id: removed.id,
        fullName: 'removed',
        phoneNumber: '',
        campDepartment: '',
        playaName: 'removed',
        loans: [{ checkoutId: removedLoan, itemId: item.id, itemName: 'Tent', quantity: 3 }],
      },
    ]);
    expect(service.importBorrowers(rows, 'replace', 'forged')).toMatchObject({
      outcome: 'confirmation_required',
    });
    expect(service.listLedger()).toEqual(before);
    expect(service.importBorrowers(rows, 'replace', preview.confirmationToken)).toMatchObject({
      outcome: 'committed',
      returned: 3,
      archived: 1,
    });
    expect(service.listItems()[0]?.available).toBe(6);
    expect(service.listBorrowers()).toEqual([expect.objectContaining({ id: retained.id })]);
    expect(service.listLoans()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ checkoutId: retainedLoan, outstanding: 2 }),
        expect.objectContaining({ checkoutId: removedLoan, outstanding: 0, lost: 2 }),
      ]),
    );
    const count = service.listLedger().length;
    expect(service.importBorrowers(rows, 'replace', preview.confirmationToken).outcome).toBe(
      'confirmation_required',
    );
    expect(service.listLedger()).toHaveLength(count);
    const next = service.previewBorrowerImport(rows, 'replace');
    service.importBorrowers(rows, 'replace', next.confirmationToken);
    expect(service.listLedger()).toHaveLength(count);
    const transfers = new InventoryTransferService(db);
    expect(() => validateRecoveryPayload(transfers.snapshot())).not.toThrow();
    const payload = await parseRecoveryWorkbook(
      await exportWorkbook(transfers.snapshot(), 'מפלצת'),
    );
    transfers.replaceWithRecovery(payload);
    expect(service.listItems()[0]?.available).toBe(6);
    expect(service.listBorrowers('', true)).toEqual(
      expect.arrayContaining([expect.objectContaining({ playaName: 'removed', archived: true })]),
    );
  });
  it('requires renewed consent after new loans, playaName edits, workbook/mode changes, or ledger replacement', () => {
    const { db, service, removed, item } = fixture();
    const rows = [row('retained')];
    const first = service.previewBorrowerImport(rows, 'replace');
    service.checkout(
      item.id,
      removed.id,
      1,
      '',
      Number(
        (service.listLocations().find((l) => l.code === 'monster') ?? service.listLocations()[0])!
          .id,
      ),
    );
    const result = service.importBorrowers(rows, 'replace', first.confirmationToken);
    expect(result.outcome).toBe('confirmation_required');
    expect(service.listItems()[0]?.available).toBe(2);
    const next = service.previewBorrowerImport(rows, 'replace');
    service.updateBorrower(removed.id, row('renamed'));
    expect(service.importBorrowers(rows, 'replace', next.confirmationToken).outcome).toBe(
      'confirmation_required',
    );
    const token = service.previewBorrowerImport(rows, 'replace').confirmationToken;
    expect(service.importBorrowers([row('retained', 'Changed')], 'replace', token).outcome).toBe(
      'confirmation_required',
    );
    expect(service.importBorrowers(rows, 'merge', token).outcome).toBe('confirmation_required');
    db.prepare('UPDATE inventory_replacement_guard SET ledger_epoch=ledger_epoch+1').run();
    expect(service.importBorrowers(rows, 'replace', token).outcome).toBe('confirmation_required');
  });
  it('rejects ambiguous normalized identities and invalid batches without mutation', () => {
    const { service } = fixture();
    expect(() => service.createBorrower(row('ＲＥＴＡＩＮＥＤ', 'retained'))).toThrow();
    const before = service.listBorrowers('', true);
    expect(() => service.previewBorrowerImport([row('retained')], 'merge')).not.toThrow();
    expect(() => service.importBorrowers([row('new'), row('NEW', 'new')], 'merge', '')).toThrow(
      'duplicate',
    );
    expect(service.listBorrowers('', true)).toEqual(before);
  });
  it('rolls back appended returns and archives if a later write fails', () => {
    const { db, service } = fixture();
    const rows = [row('retained'), row('new')];
    const before = service.listLedger();
    const preview = service.previewBorrowerImport(rows, 'replace');
    db.exec(
      "CREATE TRIGGER fail_import BEFORE INSERT ON borrowers BEGIN SELECT RAISE(ABORT, 'test failure'); END",
    );
    expect(() => service.importBorrowers(rows, 'replace', preview.confirmationToken)).toThrow(
      'test failure',
    );
    expect(service.listLedger()).toEqual(before);
    expect(service.listBorrowers()).toHaveLength(2);
  });
  it('replaces without removals while preserving all current loans', () => {
    const { service } = fixture();
    const before = service.listLedger();
    const rows = [row('retained'), row('removed')];
    const preview = service.previewBorrowerImport(rows, 'replace');
    expect(preview.affected).toEqual([]);
    expect(service.importBorrowers(rows, 'replace', preview.confirmationToken)).toMatchObject({
      outcome: 'committed',
      archived: 0,
      returned: 0,
    });
    expect(service.listLedger()).toEqual(before);
    expect(service.listBorrowers()).toHaveLength(2);
  });
  it('archives lost-only borrowers and replaces empty holdings without stock returns', () => {
    const { service, removedLoan } = fixture();
    service.markLost(removedLoan, 3, true);
    const rows = [row('retained')];
    const preview = service.previewBorrowerImport(rows, 'replace');
    expect(preview.affected).toEqual([]);
    expect(service.importBorrowers(rows, 'replace', preview.confirmationToken)).toMatchObject({
      outcome: 'committed',
      archived: 1,
      returned: 0,
    });
  });
  it('keeps consent valid through unrelated stock additions', () => {
    const { service } = fixture();
    const unrelated = service.createItem({
      name: 'Unrelated',
      kind: 'consumable',
      locationId: Number(
        (service.listLocations().find((l) => l.code === 'monster') ?? service.listLocations()[0])!
          .id,
      ),
    });
    const rows = [row('retained')];
    const preview = service.previewBorrowerImport(rows, 'replace');
    service.addStock(
      unrelated.id,
      7,
      '',
      Number(
        (service.listLocations().find((l) => l.code === 'monster') ?? service.listLocations()[0])!
          .id,
      ),
    );
    expect(service.importBorrowers(rows, 'replace', preview.confirmationToken)).toMatchObject({
      outcome: 'committed',
      returned: 3,
    });
  });
  it('requires reactivation before recovering an archived imported borrower loss', async () => {
    const { db, service, removed, removedLoan } = fixture();
    const rows = [row('retained')];
    const preview = service.previewBorrowerImport(rows, 'replace');
    service.importBorrowers(rows, 'replace', preview.confirmationToken);
    const before = service.listLedger();
    expect(() => foundReturned(service, removedLoan, 1)).toThrow('inactive');
    expect(service.listLedger()).toEqual(before);
    service.archiveBorrower(removed.id, false);
    foundReturned(service, removedLoan, 1);
    expect(service.listLoans()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ checkoutId: removedLoan, outstanding: 0, lost: 1 }),
      ]),
    );
    const transfers = new InventoryTransferService(db);
    const payload = await parseRecoveryWorkbook(
      await exportWorkbook(transfers.snapshot(), 'מפלצת'),
    );
    expect(() => transfers.replaceWithRecovery(payload)).not.toThrow();
  });
});
