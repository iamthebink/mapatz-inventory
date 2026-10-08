import { describe, expect, it } from 'vitest';
import {
  RECOVERY_IMPORT_CONFIRMATION,
  resetImportConfirmation,
  resetImportScope,
} from '../../src/web/import-confirmation.js';

describe('import confirmation copy', () => {
  it.each([false, true])('describes the actual reset scope (%s)', (resetBorrowers) => {
    const scope = resetImportScope({ resetBorrowers });
    expect(resetImportConfirmation({ resetBorrowers })).toBe(`${scope} להמשיך?`);
    expect(scope).toContain('כולל יתרות מושאלות ואבודות');
    expect(scope).toContain('מיקום ברירת המחדל ייקבע לפי הקובץ');
    expect(scope).not.toContain('ההגדרות יישמרו');
    expect(scope).toContain(
      resetBorrowers ? 'כל רשומות השואלים יימחקו' : 'רשומות השואלים יישמרו במלואן',
    );
    expect(scope).toContain(resetBorrowers ? 'לא ייטענו שואלים' : 'ההשאלות שלהם יימחקו');
  });
  it('keeps recovery copy unchanged', () => {
    expect(RECOVERY_IMPORT_CONFIRMATION).toContain('יחליף את כל');
    expect(RECOVERY_IMPORT_CONFIRMATION).toContain('הסיסמאות וההגדרות יישמרו');
  });
});
