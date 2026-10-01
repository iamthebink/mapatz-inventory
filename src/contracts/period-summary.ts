import type { Borrower } from '../domain/types.js';

export type PeriodSummaryItem = {
  itemId: number;
  name: string;
  quantity: number;
};

export type PeriodSummaryBorrower = {
  borrower: Borrower;
  total: number;
  items: PeriodSummaryItem[];
};

export type PeriodSummary = {
  start: string;
  end: string;
  borrowers: PeriodSummaryBorrower[];
};
