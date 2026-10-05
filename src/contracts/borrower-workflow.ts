import type { Borrower, Item } from '../domain/types.js';

export const BORROWER_WORKFLOW_CONTRACT_VERSION = 1 as const;

export type BorrowPart = {
  locationId: number;
  quantity: number;
  note: string;
};

export type ReturnPart = {
  locationId: number;
  usable: number;
  damaged: number;
  note: string;
};

export type LostCreditPart = {
  locationId: number;
  quantity: number;
  condition: 'usable' | 'damaged';
  note: string;
};

export type LostPart = {
  quantity: number;
  note: string;
};

export type BorrowerOperationRequest = {
  contractVersion: typeof BORROWER_WORKFLOW_CONTRACT_VERSION;
  ledgerEpoch: number;
  items: Array<{
    itemId: number;
    borrow?: BorrowPart[];
    issue?: BorrowPart[];
    return?: ReturnPart[];
    lost?: LostPart[];
    lostCredit?: LostCreditPart[];
  }>;
};

export type BorrowerCreateRequest = {
  contractVersion: typeof BORROWER_WORKFLOW_CONTRACT_VERSION;
  ledgerEpoch: number;
  playaName: string;
  fullName: string;
  phoneNumber: string;
  campDepartment: string;
};

export type BorrowerMatchKind = 'playa_name' | 'phone_number' | 'full_name';

export type BorrowerSearchSnapshot = {
  ledgerEpoch: number;
  active: Borrower[];
  archivedMatches: Array<{
    borrower: Borrower;
    matchedBy: BorrowerMatchKind;
  }>;
};

export type BorrowerDeskSnapshot = {
  borrower: Borrower;
  locations: Array<{
    id: number;
    code: string;
    name: string;
    archived: boolean;
    isDefault: boolean;
  }>;
  defaultLocationId: number | null;
  inventory: Array<Omit<Item, 'borrowed' | 'lost' | 'stockRevision'> & { selectable: boolean }>;
  holdings: Array<{
    itemId: number;
    returnable: number;
    lost: number;
  }>;
  stateRevision: number;
  ledgerEpoch: number;
};

export type BorrowerOperationConflict =
  | { scope: 'location'; code: 'invalid_location'; itemId: number; locationId: number }
  | { scope: 'borrower'; code: 'borrower_inactive'; borrowerId: number }
  | {
      scope: 'item';
      code: 'item_not_found' | 'item_archived' | 'wrong_item_kind';
      itemId: number;
    }
  | {
      scope: 'borrow';
      locationId: number;
      code: 'insufficient_stock';
      itemId: number;
      requested: number;
      availableAfterUsableReturns: number;
    }
  | {
      scope: 'issue';
      locationId: number;
      code: 'insufficient_stock';
      itemId: number;
      requested: number;
      available: number;
    }
  | {
      scope: 'return';
      code: 'returnable_balance_changed';
      itemId: number;
      requested: number;
      returnable: number;
    }
  | {
      scope: 'held';
      code: 'held_balance_changed';
      itemId: number;
      requested: number;
      returnable: number;
    }
  | {
      scope: 'lost-credit';
      code: 'lost_balance_changed';
      itemId: number;
      requested: number;
      lost: number;
    };

export type ValidationFieldError = {
  field: string;
  code: string;
  message: string;
};

export type CommandProtocolError =
  | {
      error: 'validation_error';
      message: string;
      fieldErrors: ValidationFieldError[];
    }
  | {
      error: 'idempotency_key_reused' | 'ledger_epoch_changed';
      message: string;
      outcome: 'protocol_error';
      idempotencyKey: string;
    }
  | { error: 'forbidden' | 'wrong_password'; message: string };

export type BorrowerOperationResult =
  | { outcome: 'committed'; idempotencyKey: string; replayed: boolean }
  | {
      error: 'borrower_operation_conflict';
      message: string;
      outcome: 'rejected';
      idempotencyKey: string;
      replayed: false;
      conflicts: BorrowerOperationConflict[];
      snapshot: BorrowerDeskSnapshot;
    }
  | {
      error: 'borrower_operation_attempt_rejected';
      message: string;
      outcome: 'rejected';
      idempotencyKey: string;
      replayed: true;
      currentValidation:
        | {
            status: 'conflicted';
            conflicts: BorrowerOperationConflict[];
            snapshot: BorrowerDeskSnapshot;
          }
        | { status: 'now_valid'; conflicts: []; snapshot: BorrowerDeskSnapshot };
    };

export type BorrowerCreateValidation = {
  fieldErrors: Array<{
    field: 'playaName' | 'fullName' | 'phoneNumber' | 'campDepartment';
    code: string;
    message: string;
  }>;
  matches: Array<{
    borrower: Borrower;
    status: 'active' | 'archived';
    matchedBy: BorrowerMatchKind;
  }>;
};

export type BorrowerCreateConflict =
  | ({
      error: 'borrower_conflict';
      message: string;
      outcome: 'rejected';
      idempotencyKey: string;
      replayed: false;
    } & BorrowerCreateValidation)
  | {
      error: 'borrower_create_attempt_rejected';
      message: string;
      outcome: 'rejected';
      idempotencyKey: string;
      replayed: true;
      currentValidation:
        | ({ status: 'conflicted' } & BorrowerCreateValidation)
        | { status: 'now_valid'; fieldErrors: []; matches: [] };
    };

export type BorrowerCreateResult =
  | { outcome: 'committed'; idempotencyKey: string; replayed: boolean; borrower: Borrower }
  | BorrowerCreateConflict;
