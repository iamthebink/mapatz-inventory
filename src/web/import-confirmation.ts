import type { ResetOptions } from '../domain/import-export';

export function resetImportScope({ resetBorrowers }: ResetOptions): string {
  return `ייבוא איפוס יחליף את קטלוג הפריטים, הכינויים, המיקומים והמלאי בנתונים מגיליונות Reset, וימחק את כל ההשאלות (כולל יתרות מושאלות ואבודות), יתרות הנזק, ההיסטוריה ובסיסי הדיווח. מלאי הפתיחה ובסיסי הדיווח ייבנו מחדש. ${resetBorrowers ? 'כל רשומות השואלים יימחקו; לא ייטענו שואלים מגיליונות Reset.' : 'רשומות השואלים יישמרו במלואן, כולל שואלים בארכיון, אך ההשאלות שלהם יימחקו.'} הסיסמאות ומצב מכשירי הקשר יישמרו. מיקום ברירת המחדל ייקבע לפי הקובץ.`;
}

export function resetImportConfirmation(options: ResetOptions): string {
  return `${resetImportScope(options)} להמשיך?`;
}

export const RECOVERY_IMPORT_CONFIRMATION =
  'ייבוא שחזור יחליף את כל הקטלוג, ההשאלות וההיסטוריה הקיימים במצב השמור בקובץ. הסיסמאות וההגדרות יישמרו. להמשיך?';
