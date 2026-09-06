import { describe, expect, it } from 'vitest';
import {
  RECOVERY_IMPORT_CONFIRMATION,
  RESET_IMPORT_CONFIRMATION,
} from '../../src/web/import-confirmation.js';

describe('import confirmation copy', () => {
  it('keeps explicit destructive copy for both import modes', () => {
    expect(RESET_IMPORT_CONFIRMATION).toContain('ימחק את כל');
    expect(RECOVERY_IMPORT_CONFIRMATION).toContain('יחליף את כל');
    expect(RESET_IMPORT_CONFIRMATION).toContain('הסיסמאות וההגדרות יישמרו');
    expect(RECOVERY_IMPORT_CONFIRMATION).toContain('הסיסמאות וההגדרות יישמרו');
  });
});
