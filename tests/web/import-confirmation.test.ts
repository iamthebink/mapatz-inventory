import { describe, expect, it, vi } from 'vitest';
import {
  confirmRecoveryImport,
  confirmResetImport,
  RECOVERY_IMPORT_CONFIRMATION,
  RESET_IMPORT_CONFIRMATION,
} from '../../src/web/import-confirmation.js';

describe('reset import confirmation', () => {
  it('returns false on cancellation so the caller does not start an import', () => {
    const confirm = vi.fn(() => false);
    expect(confirmResetImport(confirm)).toBe(false);
    expect(confirm).toHaveBeenCalledWith(RESET_IMPORT_CONFIRMATION);
  });

  it('returns false on recovery cancellation so the caller does not start an import', () => {
    const confirm = vi.fn(() => false);
    expect(confirmRecoveryImport(confirm)).toBe(false);
    expect(confirm).toHaveBeenCalledWith(RECOVERY_IMPORT_CONFIRMATION);
  });
});
