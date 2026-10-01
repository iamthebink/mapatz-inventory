export type RecoveryStage =
  'welcome' | 'phrase' | 'addition' | 'integral' | 'skip' | 'compliment' | 'reveal';
export type RecoveryExercises = {
  left: number;
  right: number;
  replacement: number;
  replaceLeft: boolean;
  integralMultiplier: number;
};

export function createRecoveryExercises(random: () => number = Math.random): RecoveryExercises {
  const digit = () => 1 + Math.floor(random() * 9);
  const left = digit();
  const right = digit();
  const replaceLeft = random() < 0.5;
  const original = replaceLeft ? left : right;
  // Choose from the other eight digits without an unbounded retry loop.
  const candidate = 1 + Math.floor(random() * 8);
  return {
    left,
    right,
    replaceLeft,
    replacement: candidate >= original ? candidate + 1 : candidate,
    integralMultiplier: 1 + Math.floor(random() * 3),
  };
}

export function additionOperands(exercises: RecoveryExercises, changed: boolean): [number, number] {
  return [
    changed && exercises.replaceLeft ? exercises.replacement : exercises.left,
    changed && !exercises.replaceLeft ? exercises.replacement : exercises.right,
  ];
}

export function normalizeRecoveryPhrase(value: string): string {
  return value
    .trim()
    .replace(/^["'״“”‘’]+|["'״“”‘’.,!?…:;]+$/gu, '')
    .trim()
    .replace(/\s+/gu, ' ');
}

export function acceptsRecoveryPhrase(value: string): boolean {
  return ['תראה לי את הסיסמה בבקשה', 'תראי לי את הסיסמה בבקשה'].includes(
    normalizeRecoveryPhrase(value),
  );
}

export function parseRecoveryNumber(value: string): number | null {
  const normalized = value.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(normalized)) return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}
