import type { BorrowerType } from '../domain/types.js';

export type BorrowerImportMode = 'merge' | 'replace';
export interface BorrowerImportRow {
  username: string;
  name: string;
  contact: string;
  type: BorrowerType;
}
export interface BorrowerImportPreview {
  confirmationToken: string;
  added: number;
  updated: number;
  archived: number;
  affected: Array<{
    id: number;
    username: string;
    name: string;
    loans: Array<{ checkoutId: number; itemId: number; itemName: string; quantity: number }>;
  }>;
}
export type BorrowerImportResult =
  | { outcome: 'confirmation_required'; preview: BorrowerImportPreview }
  | { outcome: 'committed'; added: number; updated: number; archived: number; returned: number };
