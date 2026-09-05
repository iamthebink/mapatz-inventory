export const RESET_IMPORT_CONFIRMATION =
  'ייבוא איפוס ימחק את כל הקטלוג, ההשאלות וההיסטוריה הקיימים. הסיסמאות וההגדרות יישמרו. להמשיך?';

export function confirmResetImport(confirm: (message: string) => boolean): boolean {
  return confirm(RESET_IMPORT_CONFIRMATION);
}
