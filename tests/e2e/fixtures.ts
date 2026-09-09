import { DatabaseSync } from 'node:sqlite';
import { expect, test as base } from '@playwright/test';

type Seed = {
  borrower: { id: number; name: string; username: string };
  item: { id: number; name: string; code: number };
  stockItem: { id: number; name: string; code: number };
  archiveItem: { id: number; name: string; code: number };
  archivedBorrower: { id: number; name: string; username: string };
  checkoutId: number;
};

type Fixtures = {
  seed: Seed;
  openLedger: () => DatabaseSync;
};

export const test = base.extend<Fixtures>({
  seed: async ({ request }, provide) => {
    const response = await request.post('/__e2e__/seed');
    expect(response.ok()).toBeTruthy();
    await provide((await response.json()) as Seed);
  },
  openLedger: async ({ request }, provide) => {
    const response = await request.get('/__e2e__/database');
    expect(response.ok()).toBeTruthy();
    const { databasePath } = (await response.json()) as { databasePath: string };
    const opened: DatabaseSync[] = [];
    await provide(() => {
      const database = new DatabaseSync(databasePath, { readOnly: true });
      opened.push(database);
      return database;
    });
    for (const database of opened) database.close();
  },
});

export { expect } from '@playwright/test';
