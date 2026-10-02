import type { BorrowerProfile } from '../domain/borrower-profile.js';

export type BorrowerImportMode = 'merge' | 'replace';
export type BorrowerImportRow = BorrowerProfile;
export interface BorrowerImportPreview {
  confirmationToken: string;
  added: number;
  updated: number;
  archived: number;
  affected: Array<{
    id: number;
    playaName: string;
    fullName: string;
    phoneNumber: string;
    campDepartment: string;
    loans: Array<{ checkoutId: number; itemId: number; itemName: string; quantity: number }>;
  }>;
}
export type BorrowerImportResult =
  | { outcome: 'confirmation_required'; preview: BorrowerImportPreview }
  | { outcome: 'committed'; added: number; updated: number; archived: number; returned: number };
