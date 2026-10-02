import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type InventoryDatabase } from '../../src/db/database.js';
import { InventoryService } from '../../src/domain/inventory.js';
import { InventoryTransferService } from '../../src/domain/import-export.js';
import { borrowerIdentity, normalizeBorrowerText } from '../../src/domain/borrower-profile.js';
import { exportWorkbook, parseRecoveryWorkbook } from '../../src/io/workbook.js';

const databases: InventoryDatabase[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));
function fixture() {
  const db = openDatabase(':memory:');
  databases.push(db);
  return { db, inventory: new InventoryService(db), transfer: new InventoryTransferService(db) };
}
const profile = { fullName: 'Ada Lovelace', playaName: '', phoneNumber: '', campDepartment: '' };

describe('borrower composite profiles', () => {
  it('creates a minimal trimmed profile and permits every repeated individual field', () => {
    const { inventory } = fixture();
    const minimal = inventory.createBorrower({ fullName: '  Ada Lovelace  ' });
    expect(minimal).toMatchObject({ ...profile, archived: false });
    const byPhone = inventory.createBorrower({ ...profile, phoneNumber: '050-123' });
    const byCamp = inventory.createBorrower({ ...profile, campDepartment: 'Camp A' });
    const byPlaya = inventory.createBorrower({ ...profile, playaName: 'Ada' });
    expect(new Set([minimal.id, byPhone.id, byCamp.id, byPlaya.id]).size).toBe(4);
    expect(() => inventory.createBorrower({ fullName: '  ' })).toThrow();
    expect(() =>
      inventory.createBorrower({ fullName: 'Ada', playaName: 'x'.repeat(101) }),
    ).toThrow();
  });

  it('enforces normalized tuple uniqueness for direct inserts and updates, including archives', () => {
    const { db, inventory } = fixture();
    const existing = inventory.createBorrower({
      ...profile,
      playaName: 'Straße',
      phoneNumber: '050-123',
      campDepartment: ' Camp A ',
    });
    inventory.archiveBorrower(existing.id, true);
    const insert = db.prepare(
      'INSERT INTO borrowers(full_name,playa_name,phone_number,camp_department) VALUES (?,?,?,?)',
    );
    expect(() => insert.run('ＡＤＡ   LOVELACE', 'STRASSE', '(050) 123', 'camp a')).toThrow(
      /UNIQUE/,
    );
    const other = inventory.createBorrower({
      ...profile,
      playaName: 'other',
      phoneNumber: '050 123',
      campDepartment: 'Camp A',
    });
    expect(() =>
      db.prepare('UPDATE borrowers SET playa_name=? WHERE id=?').run('STRASSE', other.id),
    ).toThrow(/UNIQUE/);
    expect(() => inventory.updateBorrower(other.id, { ...existing })).toThrow();
    expect(
      inventory.listBorrowers('', true).find((borrower) => borrower.id === other.id)!.playaName,
    ).toBe('other');
    expect(() => insert.run('', '', '', '')).toThrow(/CHECK/);
  });

  it('warns on real profile matches, permits deliberate distinct creation, and ignores camp-only matches', () => {
    const { inventory } = fixture();
    const existing = inventory.createBorrower({
      ...profile,
      phoneNumber: '050-123',
      campDepartment: 'Camp A',
    });
    const partial = { ...profile, phoneNumber: '(050)123', campDepartment: 'Camp B' };
    expect(inventory.validateBorrowerCreation(partial)).toMatchObject({
      fieldErrors: [],
      matches: [{ borrower: existing, matchedBy: 'phone_number' }],
    });
    const request = { contractVersion: 1 as const, ledgerEpoch: 1, ...partial };
    const result = inventory.createBorrowerCommand('00000000-0000-4000-8000-000000000201', request);
    expect(result).toMatchObject({ outcome: 'committed', borrower: partial });
    expect(
      inventory.createBorrowerCommand('00000000-0000-4000-8000-000000000201', request),
    ).toMatchObject({ ...result, replayed: true });
    expect(
      inventory.validateBorrowerCreation({
        ...profile,
        fullName: 'Another Person',
        campDepartment: 'Camp A',
      }),
    ).toEqual({ fieldErrors: [], matches: [] });
    inventory.archiveBorrower(existing.id, true);
    expect(inventory.borrowerCampSuggestions()).toEqual(['Camp A', 'Camp B']);
  });

  it('merges exact tuples, creates distinct ones, and rejects duplicated input before any returns', () => {
    const { inventory } = fixture();
    const archived = inventory.createBorrower({ ...profile, phoneNumber: '050-123' });
    inventory.archiveBorrower(archived.id, true);
    const rows = [
      { ...profile, phoneNumber: '(050)123' },
      { ...profile, phoneNumber: '052-123' },
    ];
    const preview = inventory.previewBorrowerImport(rows, 'merge');
    expect(inventory.importBorrowers(rows, 'merge', preview.confirmationToken)).toMatchObject({
      added: 1,
      updated: 1,
    });
    expect(
      inventory.listBorrowers('', true).find((borrower) => borrower.id === archived.id)!,
    ).toMatchObject({ archived: false, phoneNumber: '050-123' });
    const item = inventory.createItem({ name: 'Tent', kind: 'non_consumable' });
    inventory.addStock(item.id, 2);
    inventory.checkout(item.id, archived.id, 1);
    const before = inventory.listLedger();
    expect(() =>
      inventory.importBorrowers(
        [rows[0]!, { ...rows[0]!, phoneNumber: '050 123' }],
        'replace',
        preview.confirmationToken,
      ),
    ).toThrow(/duplicate/);
    expect(inventory.listLedger()).toEqual(before);
    expect(inventory.listLoans()[0]).toMatchObject({ borrowerId: archived.id, outstanding: 1 });
  });

  it('round-trips same-name distinct borrowers and remaps every retained event and loan', async () => {
    const source = fixture();
    const first = source.inventory.createBorrower({ ...profile, phoneNumber: '050' });
    const second = source.inventory.createBorrower({ ...profile, phoneNumber: '052' });
    const item = source.inventory.createItem({ name: 'Chairs', kind: 'non_consumable' });
    source.inventory.addStock(item.id, 5);
    const firstCheckout = source.inventory.checkout(item.id, first.id, 2);
    const secondCheckout = source.inventory.checkout(item.id, second.id, 1);
    const payload = await parseRecoveryWorkbook(await exportWorkbook(source.transfer.snapshot()));
    const destination = fixture();
    destination.transfer.replaceWithRecovery(payload);
    const restored = destination.transfer.snapshot();
    const profiles = new Map(
      restored.borrowers.map((borrower) => [borrower.phoneNumber, borrower]),
    );
    expect(profiles.get('050')!.id).not.toBe(first.id);
    expect(profiles.get('052')!.id).not.toBe(second.id);
    expect(restored.events.find((event) => event.id === firstCheckout)!.borrowerId).toBe(
      profiles.get('050')!.id,
    );
    expect(restored.loans.find((loan) => loan.checkoutId === secondCheckout)!.borrowerId).toBe(
      profiles.get('052')!.id,
    );
    destination.inventory.returnCheckout(firstCheckout, 1, 0);
    expect(
      destination.inventory.listLoans().find((loan) => loan.checkoutId === firstCheckout),
    ).toMatchObject({ outstanding: 1 });
    expect(
      destination.inventory.listLoans().find((loan) => loan.checkoutId === secondCheckout),
    ).toMatchObject({ outstanding: 1 });
    const before = destination.transfer.snapshot();
    const duplicate = structuredClone(payload);
    duplicate.borrowers[1] = { ...duplicate.borrowers[0]!, id: second.id };
    expect(() => destination.transfer.replaceWithRecovery(duplicate)).toThrow(/duplicate profile/);
    const broken = structuredClone(payload);
    broken.events.find((event) => event.id === firstCheckout)!.borrowerId = 99999;
    expect(() => destination.transfer.replaceWithRecovery(broken)).toThrow(/unknown Borrower ID/);
    expect(destination.transfer.snapshot()).toEqual(before);
    expect(borrowerIdentity(restored.borrowers[0]!)).not.toBe(
      borrowerIdentity(restored.borrowers[1]!),
    );
    expect(normalizeBorrowerText('  ＡDA\tLovelace  ')).toBe('ada lovelace');
    expect(normalizeBorrowerText('Straße Σς')).toBe('strasse σσ');
    expect(normalizeBorrowerText('Ꭰ')).toBe(normalizeBorrowerText('ꭰ'));
    expect(normalizeBorrowerText('ı')).not.toBe(normalizeBorrowerText('I'));
  });
});
