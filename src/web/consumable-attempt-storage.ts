import { isCommandUuid } from './borrower-workflow-recovery';

export type Entry = { itemId: number; locationId: number; quantity: number; note: string };
export type Attempt = { key: string; ledgerEpoch: number; items: Entry[] };
export const storageKey = 'mapatz-consumable-batch-attempt';
export function clearStoredAttempt() {
  try {
    localStorage.removeItem(storageKey);
  } catch {
    /* Storage may be unavailable. */
  }
}

export function storedAttempt(): Attempt | null {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return null;
    const attempt = value as Partial<Attempt>;
    if (
      !isCommandUuid(attempt.key) ||
      !Number.isSafeInteger(attempt.ledgerEpoch) ||
      Number(attempt.ledgerEpoch) < 1 ||
      !Array.isArray(attempt.items) ||
      !attempt.items.length
    )
      return null;
    if (
      !attempt.items.every(
        (item) =>
          Number.isSafeInteger(item.itemId) &&
          item.itemId > 0 &&
          Number.isSafeInteger(item.locationId) &&
          item.locationId > 0 &&
          Number.isSafeInteger(item.quantity) &&
          item.quantity > 0 &&
          typeof item.note === 'string' &&
          item.note.length <= 500,
      )
    )
      return null;
    return attempt as Attempt;
  } catch {
    return null;
  }
}

export const hasStoredConsumableAttempt = () => storedAttempt() !== null;
