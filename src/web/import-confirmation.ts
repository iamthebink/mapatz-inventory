export const RESET_IMPORT_CONFIRMATION =
  'ייבוא איפוס ימחק את כל הקטלוג, ההשאלות וההיסטוריה הקיימים. הסיסמאות וההגדרות יישמרו. להמשיך?';
export const RECOVERY_IMPORT_CONFIRMATION =
  'ייבוא שחזור יחליף את כל הקטלוג, ההשאלות וההיסטוריה הקיימים במצב השמור בקובץ. הסיסמאות וההגדרות יישמרו. להמשיך?';

export function confirmResetImport(confirm: (message: string) => boolean): boolean {
  return confirm(RESET_IMPORT_CONFIRMATION);
}

export function confirmRecoveryImport(confirm: (message: string) => boolean): boolean {
  return confirm(RECOVERY_IMPORT_CONFIRMATION);
}
