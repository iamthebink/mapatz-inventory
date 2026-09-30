import { describe, expect, it } from 'vitest';
import {
  acceptsRecoveryPhrase,
  additionOperands,
  createRecoveryExercises,
  parseRecoveryNumber,
} from '../../src/web/admin-password-recovery';

describe('password recovery exercises', () => {
  it('accepts both genders and surrounding quotes, punctuation and whitespace', () => {
    for (const phrase of ['תראה לי את הסיסמה בבקשה', 'תראי לי את הסיסמה בבקשה']) {
      expect(acceptsRecoveryPhrase(`  ״${phrase.replaceAll(' ', '  ')}״!  `)).toBe(true);
    }
    expect(acceptsRecoveryPhrase('תראה לי את הסיסמה')).toBe(false);
  });
  it('uses whole finite numeric strings, including equivalent decimals', () => {
    for (const value of ['', ' ', '2abc', 'Infinity', 'NaN', '0x2', '1e999'])
      expect(parseRecoveryNumber(value)).toBeNull();
    expect(parseRecoveryNumber(' 2.00 ')).toBe(2);
    expect(parseRecoveryNumber('+2e0')).toBe(2);
  });
  it('changes exactly one operand to another digit and freezes the exercises', () => {
    for (let seed = 0; seed < 100; seed++) {
      let index = seed;
      const exercises = createRecoveryExercises(() => ((index++ * 37) % 100) / 100);
      const before = additionOperands(exercises, false);
      const after = additionOperands(exercises, true);
      expect(before.filter((digit, i) => digit !== after[i])).toHaveLength(1);
      for (const digit of [...before, ...after]) expect(digit).toBeGreaterThanOrEqual(1);
      for (const digit of [...before, ...after]) expect(digit).toBeLessThanOrEqual(9);
      expect([1, 2, 3]).toContain(exercises.integralMultiplier);
      expect(additionOperands(exercises, false)).toEqual(before);
    }
  });
});
