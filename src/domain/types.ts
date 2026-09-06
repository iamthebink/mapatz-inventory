export type Role = 'operator' | 'admin';
export type ItemKind = 'consumable' | 'non_consumable';
export type BorrowerType = 'individual' | 'camp_organization' | 'other';
export type EventKind =
  | 'stock_added'
  | 'stock_removed'
  | 'issued'
  | 'checked_out'
  | 'returned_usable'
  | 'returned_damaged'
  | 'marked_lost'
  | 'unmarked_lost'
  | 'repaired'
  | 'written_off';

export interface Item {
  id: number;
  code: number;
  name: string;
  kind: ItemKind;
  lotSize: number | null;
  locationId: number | null;
  archived: boolean;
  aliases: string[];
  available: number;
  damaged: number;
}

export interface Borrower {
  id: number;
  username: string;
  name: string;
  contact: string;
  type: BorrowerType;
  archived: boolean;
}

export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}
