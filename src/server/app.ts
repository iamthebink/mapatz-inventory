import express, { type ErrorRequestHandler, type Express } from 'express';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type InventoryDatabase } from '../db/database.js';
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
  accessToken?: string;
  desktopRecovery?: boolean;
}

export function createApp(options: AppOptions): Express {
  const app = express();
  if (options.accessToken)
    app.use((req, res, next) => {
      if (req.headers['x-mapatz-desktop-token'] !== options.accessToken) {
        res.sendStatus(403);
        return;
      }
      next();
    });
  const legacyJson = express.json({ limit: '32kb' });
  const sessions = new SessionStore(
    options.database,
    options.adminPassword,
    options.now,
    options.adminIdleMs,
    undefined,
    options.desktopRecovery === true && Boolean(options.accessToken),
  );
  const service = new InventoryService(options.database);
  const transfers = new InventoryTransferService(options.database);
  app.use(
    '/api',
    (req, res, next) => {
      const path = req.path.toLowerCase();
      const commandRoute =
        req.method === 'POST' &&
        (/^\/borrowers\/?$/.test(path) || /^\/borrowers\/[^/]+\/operations\/?$/.test(path));
      if (commandRoute) return next();
      legacyJson(req, res, next);
    },
    (req, res, next) => {
      const session = sessions.get(readCookie(req.headers.cookie, 'mapatz_session'));
      res.cookie('mapatz_session', session.token, {
        httpOnly: true,
        sameSite: 'strict',
        secure: false,
        path: '/',
      });
      res.locals.session = session;
      next();
    },
    apiRouter(
      service,
      transfers,
      sessions,
      options.desktopRecovery === true && Boolean(options.accessToken),
    ),
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
    if (error instanceof URIError && 'status' in error && error.status === 400)
      return void res.status(400).json({ error: 'invalid_path', message: 'Invalid request path' });
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
