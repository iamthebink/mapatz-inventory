import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

export default async function globalTeardown() {
  const databaseResponse = await fetch('http://127.0.0.1:4173/__e2e__/database');
  if (!databaseResponse.ok) throw new Error('Could not locate the E2E temporary database');
  const { databasePath } = (await databaseResponse.json()) as { databasePath: string };
  const directory = dirname(databasePath);
  const shutdownResponse = await fetch('http://127.0.0.1:4173/__e2e__/shutdown', {
    method: 'POST',
  });
  if (!shutdownResponse.ok) throw new Error('Could not request E2E server shutdown');

  const deadline = Date.now() + 5_000;
  while (existsSync(directory) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (existsSync(directory)) {
    throw new Error(`E2E temporary directory was not removed: ${directory}`);
  }
}
