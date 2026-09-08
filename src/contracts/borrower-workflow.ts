import type { Borrower, Item } from '../domain/types.js';

export const BORROWER_WORKFLOW_CONTRACT_VERSION = 1 as const;

export type BorrowPart = {
  quantity: number;
  note: string;
};

export type ReturnPart = {
  usable: number;
  damaged: number;
  note: string;
};

export type BorrowerOperationRequest = {
  contractVersion: typeof BORROWER_WORKFLOW_CONTRACT_VERSION;
  ledgerEpoch: number;
  items: Array<{
    itemId: number;
    borrow?: BorrowPart[];
    return?: ReturnPart[];
  }>;
};

export type BorrowerCreateRequest = {
  contractVersion: typeof BORROWER_WORKFLOW_CONTRACT_VERSION;
  ledgerEpoch: number;
  username: string;
  name: string;
  contact: string;
  type: Borrower['type'];
};

export type BorrowerMatchKind = 'username' | 'contact' | 'full_name';

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
  inventory: Array<Item & { selectable: boolean }>;
  holdings: Array<{
    itemId: number;
    returnable: number;
    lost: number;
  }>;
  asOfEventId: number;
  ledgerEpoch: number;
};

export type BorrowerOperationConflict =
  | { scope: 'borrower'; code: 'borrower_inactive'; borrowerId: number }
  | {
      scope: 'item';
      code: 'item_not_found' | 'item_archived' | 'wrong_item_kind';
      itemId: number;
    }
  | {
      scope: 'borrow';
      code: 'insufficient_stock';
      itemId: number;
      requested: number;
      availableAfterUsableReturns: number;
    }
  | {
      scope: 'return';
      code: 'returnable_balance_changed';
      itemId: number;
      requested: number;
      returnable: number;
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
    field: 'username' | 'name' | 'contact' | 'type';
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
