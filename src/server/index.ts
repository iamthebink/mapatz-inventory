import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDatabase } from '../db/database.js';
import { createApp } from './app.js';
export { createApp, type AppOptions } from './app.js';

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href &&
  process.env.NODE_ENV !== 'test'
) {
  const db = openDatabase(resolve(process.env.DATA_DIR ?? './data', 'inventory.sqlite'));
  const app = createApp({ database: db, adminPassword: process.env.ADMIN_PASSWORD });
  const port = Number(process.env.PORT ?? 3000);
  app.listen(port, () => console.log(`Mapatz inventory listening on http://localhost:${port}`));
}
