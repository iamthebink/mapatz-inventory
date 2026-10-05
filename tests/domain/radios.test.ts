import ExcelJS from 'exceljs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { InventoryTransferService } from '../../src/domain/import-export.js';
import { RadioService } from '../../src/domain/radios.js';
import { exportWorkbook, parseRecoveryWorkbook } from '../../src/io/workbook.js';
describe('radio fleet', () => {
  it('persists numbered custody and lost state across a database close and reopen', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mapatz-radios-'));
    const filename = join(directory, 'inventory.sqlite');
    try {
      const first = openDatabase(filename);
      const radios = new RadioService(first);
      const generation = radios.setCount(3, radios.fleet().generation).generation;
      radios.custody(1, generation, 'Unregistered worker', 'Production');
      radios.setLost(1, generation, true);
      radios.custody(3, generation, 'MDA worker', 'Medics');
      const saved = radios.fleet();
      first.close();
      const reopened = openDatabase(filename);
      expect(new RadioService(reopened).fleet()).toEqual(saved);
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('rolls back count, every row, and generation when insertion fails partway through reset', () => {
    const db = openDatabase(':memory:');
    try {
      const radios = new RadioService(db);
      const generation = radios.setCount(2, radios.fleet().generation).generation;
      radios.custody(1, generation, 'Production', 'Stage');
      radios.setLost(2, generation, true);
      const before = radios.fleet();
      db.exec(`CREATE TRIGGER fail_radio_insert BEFORE INSERT ON radios
        WHEN NEW.number = 2 BEGIN SELECT RAISE(ABORT, 'injected radio insert failure'); END`);
      expect(() => radios.setCount(3, generation)).toThrow('injected radio insert failure');
      expect(radios.fleet()).toEqual(before);
      expect(db.isTransaction).toBe(false);
    } finally {
      db.close();
    }
  });
  it('resets only on changed count, preserves independent custody, and locks lost radios', () => {
    const db = openDatabase(':memory:');
    const radios = new RadioService(db);
    const initial = radios.fleet();
    expect(initial).toEqual({
      count: 40,
      generation: 1,
      radios: Array.from({ length: 40 }, (_, index) => ({
        number: index + 1,
        holder: 'צוללת',
        team: '',
        lost: false,
      })),
    });
    const three = radios.setCount(3, initial.generation);
    expect(three.radios.map((radio) => radio.holder)).toEqual(['צוללת', 'צוללת', 'צוללת']);
    radios.custody(1, three.generation, 'MDA worker', 'MDA');
    radios.custody(2, three.generation, 'MDA worker', '');
    const lost = radios.setLost(1, three.generation, true);
    expect(lost.radios[0]).toMatchObject({ holder: 'MDA worker', team: 'MDA', lost: true });
    expect(() => radios.custody(1, three.generation, 'Other', '')).toThrow();
    expect(() => radios.returnRadio(1, three.generation)).toThrow();
    expect(() => radios.setLost(1, three.generation, true)).toThrow();
    expect(radios.setCount(3, three.generation)).toEqual(lost);
    radios.setLost(1, three.generation, false);
    expect(radios.returnRadio(1, three.generation).radios[0]).toMatchObject({
      holder: 'צוללת',
      team: '',
    });
    expect(() => radios.custody(2, three.generation, '  ', '')).toThrow();
    expect(() => radios.setCount(-1, three.generation)).toThrow();
    expect(() => radios.setCount(1.5, three.generation)).toThrow();
    const reset = radios.setCount(2, three.generation);
    expect(reset.radios).toEqual([
      { number: 1, holder: 'צוללת', team: '', lost: false },
      { number: 2, holder: 'צוללת', team: '', lost: false },
    ]);
    expect(() => radios.custody(1, three.generation, 'Stale', '')).toThrow();
    expect(radios.setCount(0, reset.generation).radios).toEqual([]);
    db.close();
  });
  it('round trips recovery exactly, rejects invalid fleets atomically, and preserves radios on equipment reset', async () => {
    const db = openDatabase(':memory:');
    const radios = new RadioService(db);
    const transfers = new InventoryTransferService(db);
    const generation = radios.setCount(3, radios.fleet().generation).generation;
    radios.custody(1, generation, 'MDA', 'Medic');
    radios.setLost(1, generation, true);
    radios.custody(2, generation, 'Production', 'Stage');
    const saved = transfers.snapshot();
    const workbook = await exportWorkbook(saved);
    const parsed = await parseRecoveryWorkbook(workbook);
    radios.setCount(1, generation);
    const preRecovery = radios.fleet().generation;
    transfers.replaceWithRecovery(parsed);
    expect(radios.fleet().radios).toEqual(saved.radios);
    expect(radios.fleet().generation).toBeGreaterThan(preRecovery);
    expect(() => radios.custody(1, generation, 'Stale', '')).toThrow();
    expect(() => radios.custody(1, radios.fleet().generation, 'Other', '')).toThrow();
    const current = transfers.snapshot();
    for (const invalid of [
      { ...current, radioCount: 2 },
      { ...current, radios: [current.radios[0]!, current.radios[0]!, current.radios[2]!] },
      { ...current, radios: [{ ...current.radios[0]!, number: 4 }, ...current.radios.slice(1)] },
      { ...current, radios: [{ ...current.radios[0]!, holder: ' ' }, ...current.radios.slice(1)] },
      {
        ...current,
        radios: [
          { ...current.radios[0]!, lost: 1 as unknown as boolean },
          ...current.radios.slice(1),
        ],
      },
    ]) {
      expect(() => transfers.replaceWithRecovery(invalid)).toThrow();
      expect(transfers.snapshot()).toEqual(current);
    }
    transfers.replaceWithReset({ locations: [], items: [] });
    expect(radios.fleet().radios).toEqual(saved.radios);
    db.close();
  });
  it('rolls back radio replacement and generation when a later recovery write fails', () => {
    const db = openDatabase(':memory:');
    try {
      const radios = new RadioService(db);
      const transfers = new InventoryTransferService(db);
      const generation = radios.setCount(2, radios.fleet().generation).generation;
      radios.custody(1, generation, 'Old holder', 'Old team');
      radios.setLost(1, generation, true);
      const beforeFleet = radios.fleet();
      const beforeSnapshot = transfers.snapshot();
      const recovery = {
        ...beforeSnapshot,
        locations: [{ name: 'Trigger failure', archived: false, isDefault: false }],
        radioCount: 1,
        radios: [{ number: 1, holder: 'Recovered holder', team: '', lost: false }],
      };
      db.exec(`CREATE TRIGGER fail_recovery_location BEFORE INSERT ON locations
        WHEN NEW.name = 'Trigger failure'
        BEGIN SELECT RAISE(ABORT, 'injected later recovery failure'); END`);
      expect(() => transfers.replaceWithRecovery(recovery)).toThrow(
        'injected later recovery failure',
      );
      expect(radios.fleet()).toEqual(beforeFleet);
      expect(transfers.snapshot()).toEqual(beforeSnapshot);
      expect(db.isTransaction).toBe(false);
    } finally {
      db.close();
    }
  });
  it('rejects full workbooks missing either required radio sheet', async () => {
    const db = openDatabase(':memory:');
    try {
      const radios = new RadioService(db);
      const generation = radios.setCount(1, radios.fleet().generation).generation;
      radios.custody(1, generation, 'Holder', 'Team');
      const workbook = await exportWorkbook(new InventoryTransferService(db).snapshot());
      for (const sheetName of ['Recovery Radio Fleet', 'Recovery Radios']) {
        const edited = new ExcelJS.Workbook();
        await edited.xlsx.load(
          workbook.buffer.slice(
            workbook.byteOffset,
            workbook.byteOffset + workbook.byteLength,
          ) as ArrayBuffer,
        );
        edited.removeWorksheet(edited.getWorksheet(sheetName)!.id);
        const invalid = Buffer.from(await edited.xlsx.writeBuffer());
        await expect(parseRecoveryWorkbook(invalid)).rejects.toThrow(
          `Missing required sheet "${sheetName}"`,
        );
      }
      expect(radios.fleet().radios).toEqual([
        { number: 1, holder: 'Holder', team: 'Team', lost: false },
      ]);
    } finally {
      db.close();
    }
  });
  it('round trips long holder and team text up to the Excel cell limit', async () => {
    const db = openDatabase(':memory:');
    try {
      const radios = new RadioService(db);
      const holder = 'H'.repeat(101);
      const team = 'T'.repeat(501);
      const generation = radios.setCount(1, radios.fleet().generation).generation;
      radios.custody(1, generation, holder, team);
      const snapshot = new InventoryTransferService(db).snapshot();
      const restored = await parseRecoveryWorkbook(await exportWorkbook(snapshot));
      expect(restored.radios).toEqual(snapshot.radios);
      expect(restored.radios[0]).toMatchObject({ holder, team });
      expect(() => radios.custody(1, generation, 'H'.repeat(32768), '')).toThrow();
      expect(() => radios.custody(1, generation, holder, 'T'.repeat(32768))).toThrow();
    } finally {
      db.close();
    }
  });
});
