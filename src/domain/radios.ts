import type { InventoryDatabase } from '../db/database.js';
import { transaction } from '../db/database.js';
import { DomainError, type Radio, type RadioFleet } from './types.js';

type RadioRow = { number: number; holder: string; team: string; lost: number };

export const RADIO_HOME = 'צוללת';
export const RADIO_TEXT_MAX_LENGTH = 32767;

export function validateRadioFleet(count: number, radios: Radio[]): void {
  if (
    !Number.isSafeInteger(count) ||
    count < 0 ||
    !Array.isArray(radios) ||
    radios.length !== count
  )
    throw new DomainError('invalid_radio_fleet', 'Radio fleet count does not match its rows');
  const seen = new Set<number>();
  for (const radio of radios) {
    if (
      !Number.isSafeInteger(radio.number) ||
      radio.number < 1 ||
      radio.number > count ||
      seen.has(radio.number)
    )
      throw new DomainError(
        'invalid_radio_fleet',
        'Radio numbers must be exactly 1 through the fleet count',
      );
    if (
      typeof radio.holder !== 'string' ||
      !radio.holder.trim() ||
      radio.holder.length > RADIO_TEXT_MAX_LENGTH ||
      typeof radio.team !== 'string' ||
      radio.team.length > RADIO_TEXT_MAX_LENGTH ||
      typeof radio.lost !== 'boolean'
    )
      throw new DomainError('invalid_radio_fleet', 'Radio holder, team or lost status is invalid');
    seen.add(radio.number);
  }
}

export class RadioService {
  constructor(private readonly db: InventoryDatabase) {}

  fleet(): RadioFleet {
    const state = this.db
      .prepare('SELECT count, generation FROM radio_fleet WHERE singleton=1')
      .get() as { count: number; generation: number };
    const radios = (
      this.db
        .prepare('SELECT number, holder, team, lost FROM radios ORDER BY number')
        .all() as RadioRow[]
    ).map((row) => ({
      number: row.number,
      holder: row.holder,
      team: row.team,
      lost: Boolean(row.lost),
    }));
    return { count: state.count, generation: state.generation, radios };
  }

  private assertGeneration(generation: number): void {
    const current = (
      this.db.prepare('SELECT generation FROM radio_fleet WHERE singleton=1').get() as {
        generation: number;
      }
    ).generation;
    if (current !== generation)
      throw new DomainError('stale_radio_fleet', 'מכשירי הקשר השתנו. יש לרענן ולנסות שוב', 409);
  }

  private current(number: number): RadioRow {
    const row = this.db
      .prepare('SELECT number, holder, team, lost FROM radios WHERE number=?')
      .get(number) as RadioRow | undefined;
    if (!row) throw new DomainError('radio_not_found', 'מכשיר הקשר לא נמצא', 404);
    return row;
  }

  setCount(count: number, generation: number): RadioFleet {
    if (!Number.isSafeInteger(count) || count < 0)
      throw new DomainError('invalid_count', 'מספר מכשירי הקשר חייב להיות מספר שלם שאינו שלילי');
    return transaction(this.db, () => {
      this.assertGeneration(generation);
      const oldCount = (
        this.db.prepare('SELECT count FROM radio_fleet WHERE singleton=1').get() as {
          count: number;
        }
      ).count;
      if (oldCount !== count) {
        this.db.prepare('DELETE FROM radios').run();
        const insert = this.db.prepare(
          'INSERT INTO radios(number, holder, team, lost) VALUES (?, ?, ?, 0)',
        );
        for (let number = 1; number <= count; number++) insert.run(number, RADIO_HOME, '');
        this.db
          .prepare('UPDATE radio_fleet SET count=?, generation=generation+1 WHERE singleton=1')
          .run(count);
      }
      return this.fleet();
    });
  }

  custody(number: number, generation: number, holder: string, team: string): RadioFleet {
    if (
      typeof holder !== 'string' ||
      !holder.trim() ||
      holder.length > RADIO_TEXT_MAX_LENGTH ||
      typeof team !== 'string' ||
      team.length > RADIO_TEXT_MAX_LENGTH
    )
      throw new DomainError('invalid_holder', 'יש להזין שם מחזיק/ה');
    return transaction(this.db, () => {
      this.assertGeneration(generation);
      if (this.current(number).lost)
        throw new DomainError('radio_lost', 'מכשיר קשר אבוד נעול לעדכון מיקום', 409);
      this.db
        .prepare('UPDATE radios SET holder=?, team=? WHERE number=?')
        .run(holder.trim(), team.trim(), number);
      return this.fleet();
    });
  }

  returnRadio(number: number, generation: number): RadioFleet {
    return this.custody(number, generation, RADIO_HOME, '');
  }

  setLost(number: number, generation: number, lost: boolean): RadioFleet {
    return transaction(this.db, () => {
      this.assertGeneration(generation);
      const current = this.current(number);
      if (Boolean(current.lost) === lost)
        throw new DomainError('invalid_radio_transition', 'מצב מכשיר הקשר כבר השתנה', 409);
      this.db.prepare('UPDATE radios SET lost=? WHERE number=?').run(Number(lost), number);
      return this.fleet();
    });
  }

  restore(count: number, radios: Radio[]): void {
    validateRadioFleet(count, radios);
    this.db.prepare('DELETE FROM radios').run();
    const insert = this.db.prepare(
      'INSERT INTO radios(number, holder, team, lost) VALUES (?, ?, ?, ?)',
    );
    for (const radio of radios)
      insert.run(radio.number, radio.holder, radio.team, Number(radio.lost));
    this.db
      .prepare('UPDATE radio_fleet SET count=?, generation=generation+1 WHERE singleton=1')
      .run(count);
  }
}
