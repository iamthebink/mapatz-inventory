export type Role = 'operator' | 'admin';
export type ItemKind = 'consumable' | 'non_consumable' | 'camp_equipment';
export type EventKind =
  | 'stock_added'
  | 'stock_removed'
  | 'issued'
  | 'checked_out'
  | 'returned_usable'
  | 'returned_damaged'
  | 'marked_lost'
  | 'found_returned'
  | 'found_returned_damaged'
  | 'repaired'
  | 'written_off'
  | 'transferred_out'
  | 'transferred_in'
  | 'damaged_transferred_out'
  | 'damaged_transferred_in';

export interface LocationBalance {
  locationId: number;
  available: number;
  damaged: number;
}

export interface Item {
  id: number;
  name: string;
  kind: ItemKind;
  lotSize: number | null;
  balances: LocationBalance[];
  archived: boolean;
  aliases: string[];
  available: number;
  borrowed: number;
  lost: number;
  damaged: number;
  stockRevision: number;
}

export interface Borrower {
  id: number;
  playaName: string;
  fullName: string;
  phoneNumber: string;
  campDepartment: string;
  archived: boolean;
}

export interface Radio {
  number: number;
  holder: string;
  team: string;
  lost: boolean;
}

export interface RadioFleet {
  count: number;
  generation: number;
  radios: Radio[];
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
