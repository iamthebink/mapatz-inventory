import express, { type ErrorRequestHandler, type Express } from 'express';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, type InventoryDatabase } from '../db/database.js';
import { InventoryService } from '../domain/inventory.js';
import { InventoryTransferService } from '../domain/import-export.js';
import { DomainError } from '../domain/types.js';
import { apiRouter } from './routes.js';
import { readCookie, SessionStore } from './session.js';

export interface AppOptions {
  database: InventoryDatabase;
  adminPassword?: string;
  now?: () => number;
  adminIdleMs?: number;
  serveWeb?: boolean;
}

export function createApp(options: AppOptions): Express {
  const app = express();
  const sessions = new SessionStore(
    options.database,
    options.adminPassword,
    options.now,
    options.adminIdleMs,
  );
  const service = new InventoryService(options.database);
  const transfers = new InventoryTransferService(options.database);
  app.use(express.json({ limit: '32kb' }));
  app.use(
    '/api',
    (req, res, next) => {
      const session = sessions.get(readCookie(req.headers.cookie, 'mapatz_session'));
      res.cookie('mapatz_session', session.token, {
        httpOnly: true,
        sameSite: 'strict',
        secure: false,
        path: '/',
      });
      res.locals.session = sessions.touch(session);
      next();
    },
    apiRouter(service, transfers, sessions),
    (_req, res) => {
      res.status(404).json({ error: 'not_found', message: 'נתיב API לא נמצא' });
    },
  );

  if (options.serveWeb !== false) {
    const web = resolve(fileURLToPath(new URL('../web', import.meta.url)));
    app.use(express.static(web));
    app.get('/{*splat}', (_req, res) => res.sendFile(resolve(web, 'index.html')));
  }

  const errors: ErrorRequestHandler = (error, _req, res, next) => {
    void next;
    if (error instanceof DomainError)
      return void res.status(error.status).json({ error: error.code, message: error.message });
    if (
      error &&
      typeof error === 'object' &&
      'type' in error &&
      (error.type === 'entity.parse.failed' || error.type === 'entity.too.large')
    )
      return void res
        .status(400)
        .json({ error: 'invalid_json', message: 'גוף הבקשה אינו JSON תקין או גדול מדי' });
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      String(error.code).startsWith('SQLITE_CONSTRAINT')
    )
      return void res
        .status(409)
        .json({ error: 'conflict', message: 'הערך כבר קיים או אינו תקין' });
    console.error(error);
    res.status(500).json({ error: 'internal_error', message: 'אירעה שגיאה פנימית' });
  };
  app.use(errors);
  return app;
}

if (process.env.NODE_ENV !== 'test') {
  const dataDir = process.env.DATA_DIR ?? './data';
  const db = openDatabase(resolve(dataDir, 'inventory.sqlite'));
  const app = createApp({
    database: db,
    adminPassword: process.env.ADMIN_PASSWORD,
  });
  const port = Number(process.env.PORT ?? 3000);
  app.listen(port, () => console.log(`Mapatz inventory listening on http://localhost:${port}`));
}
