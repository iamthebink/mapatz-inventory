export function formatAdminCountdown(remainingSeconds: number): string {
  const seconds = Math.max(0, Math.min(600, Math.ceil(remainingSeconds)));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export const recoveryGateMs = 5_000;
export const recoveryMercyMs = 8_000;
export const recoveryStages = [
  {
    title: 'אה, שכחת את סיסמת המנהל?',
    text: 'את הסיסמה הפשוטה. זאת שכבר אמרו לך. יא ליצן, המחסנאי בדיוק התיישב לשתות קפה ועכשיו שנינו כאן בגלל שהמוח שלך החליט לצאת להפסקה.',
    action: 'כן, עשיתי את זה',
  },
  {
    title: 'רישום תקלה: זיכרון חסר',
    text: 'בדקתי בין הברגים, מתחת לטפסים, ובקופסת ה״ברור שאזכור״ שלך. אין שם פאקינג כלום. הסיסמה פשוטה; הסיפור שלך פחות.',
    action: 'להמשיך בהשפלה',
  },
  {
    title: 'ספירת מלאי אישית',
    text: 'יש לנו מפתח, מחברת, ופתק שכתוב עליו ״לא לשכוח״. נחש מי הצליח לאבד דווקא את הדבר שהיה אמור להישאר בתוך הראש. רמז: הוא לוחץ עכשיו על הכפתור.',
    action: 'זה אני, לעזאזל',
  },
  {
    title: 'חתימה על האירוע',
    text: 'אני אוהב אותך מספיק כדי לעזור, ומספיק קטנוני כדי שתישאר כאן עשרים שניות ותחשוב על מה שעשית. עוד רגע אראה לך את הסיסמה הפשוטה עד כדי גיחוך.',
    action: 'יאללה, תראה לי',
  },
] as const;

export function recoveryRemainingMs(
  stage: number,
  elapsedMs: number,
  stageElapsedMs: number,
  penaltyMs: number,
): number {
  return Math.max(
    0,
    recoveryGateMs - stageElapsedMs,
    stage === recoveryStages.length - 1
      ? recoveryStages.length * recoveryGateMs + penaltyMs - elapsedMs
      : 0,
  );
}
