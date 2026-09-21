export function normalizeItemName(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase();
}
