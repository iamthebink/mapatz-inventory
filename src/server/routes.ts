import express, { Router, type RequestHandler } from 'express';
import { z, type ZodType } from 'zod';
import type { InventoryService } from '../domain/inventory.js';
import type { InventoryTransferService } from '../domain/import-export.js';
import { DomainError, type Role } from '../domain/types.js';
import { exportWorkbook, parseRecoveryWorkbook, parseResetWorkbook } from '../io/workbook.js';
import { WORKBOOK_CONTRACT } from '../io/workbook-contract.js';
import type { SessionStore } from './session.js';

const positive = z.number().int().positive();
const id = z.coerce.number().int().positive();
const aliases = z.array(z.string().trim().min(1).max(100)).max(20);
const itemInput = z.object({
  name: z.string().trim().min(1).max(100),
  kind: z.enum(['consumable', 'non_consumable']),
  lotSize: positive.nullish(),
  locationId: positive.nullish(),
  aliases: aliases.optional(),
});
const borrowerInput = z.object({
  username: z.string().trim().min(2).max(40),
  name: z.string().trim().min(1).max(100),
  contact: z.string().max(500).optional(),
  type: z.enum(['individual', 'camp_organization', 'other']),
});

const parse = <T>(schema: ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new DomainError('validation_error', result.error.issues[0]?.message ?? 'Invalid input');
  return result.data;
};

const route =
  (handler: RequestHandler): RequestHandler =>
  async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (error) {
      next(error);
    }
  };

function requireRole(...roles: Role[]): RequestHandler {
  return (req, res, next) => {
    const session = res.locals.session as { role: Role };
    if (!roles.includes(session.role))
      return next(new DomainError('forbidden', 'אין הרשאה לפעולה זו', 403));
    next();
  };
}

export function apiRouter(
  service: InventoryService,
  transfers: InventoryTransferService,
  sessions: SessionStore,
): Router {
  const api = Router();

  api.get('/session', (req, res) =>
    res.json({ role: res.locals.session.role, deadline: res.locals.session.deadline }),
  );
  api.post(
    '/session/role',
    route((req, res) => {
      const body = parse(
        z.object({ role: z.enum(['guest', 'operator', 'admin']), password: z.string().optional() }),
        req.body,
      );
      const before = res.locals.session.role;
      const session = sessions.changeRole(res.locals.session, body.role, body.password);
      if (session.role !== body.role && before !== body.role)
        throw new DomainError('wrong_password', 'סיסמה שגויה', 401);
      res.json({ role: session.role, deadline: session.deadline });
    }),
  );

  api.get('/locations', (req, res) => res.json(service.listLocations(req.query.all === '1')));
  api.post(
    '/locations',
    requireRole('admin'),
    route((req, res) => {
      const body = parse(
        z.object({
          code: z.string().trim().min(1).max(40),
          name: z.string().trim().min(1).max(100),
        }),
        req.body,
      );
      res.status(201).json(service.createLocation(body.code, body.name));
    }),
  );
  api.put(
    '/locations/:id',
    requireRole('admin'),
    route((req, res) => {
      const body = parse(
        z.object({
          code: z.string().trim().min(1).max(40),
          name: z.string().trim().min(1).max(100),
          archived: z.boolean().optional(),
        }),
        req.body,
      );
      service.updateLocation(parse(id, req.params.id), body);
      res.status(204).end();
    }),
  );

  api.get('/items', (req, res) =>
    res.json(service.listItems(String(req.query.q ?? ''), req.query.all === '1')),
  );
  api.post(
    '/items',
    requireRole('admin'),
    route((req, res) => res.status(201).json(service.createItem(parse(itemInput, req.body)))),
  );
  api.put(
    '/items/:id',
    requireRole('admin'),
    route((req, res) => {
      const body = parse(itemInput.omit({ kind: true }), req.body);
      res.json(service.updateItem(parse(id, req.params.id), body));
    }),
  );
  api.post(
    '/items/:id/archive',
    requireRole('admin'),
    route((req, res) => {
      const body = parse(z.object({ archived: z.boolean() }), req.body);
      service.archiveItem(parse(id, req.params.id), body.archived);
      res.status(204).end();
    }),
  );

  api.get('/borrowers', (req, res) =>
    res.json(service.listBorrowers(String(req.query.q ?? ''), req.query.all === '1')),
  );
  api.post(
    '/borrowers',
    requireRole('operator', 'admin'),
    route((req, res) =>
      res.status(201).json(service.createBorrower(parse(borrowerInput, req.body))),
    ),
  );
  api.put(
    '/borrowers/:id',
    requireRole('admin'),
    route((req, res) =>
      res.json(service.updateBorrower(parse(id, req.params.id), parse(borrowerInput, req.body))),
    ),
  );
  api.post(
    '/borrowers/:id/archive',
    requireRole('admin'),
    route((req, res) => {
      const body = parse(z.object({ archived: z.boolean() }), req.body);
      service.archiveBorrower(parse(id, req.params.id), body.archived);
      res.status(204).end();
    }),
  );

  api.get('/loans', (req, res) => res.json(service.listLoans()));
  api.get('/ledger', (req, res) => res.json(service.listLedger()));
  api.get(
    '/workbook',
    requireRole('admin'),
    route(async (_req, res) => {
      const buffer = await exportWorkbook(transfers.snapshot());
      res.type(WORKBOOK_CONTRACT.mimeType).attachment(WORKBOOK_CONTRACT.filename).send(buffer);
    }),
  );
  api.post(
    '/workbook/reset',
    requireRole('admin'),
    (req, _res, next) => {
      if (req.header('x-mapatz-confirmed') !== 'true')
        return next(
          new DomainError(
            'confirmation_required',
            'יש לאשר במפורש את מחיקת המלאי הקיים לפני הייבוא',
            400,
          ),
        );
      next();
    },
    express.raw({ type: WORKBOOK_CONTRACT.mimeType, limit: '10mb' }),
    route(async (req, res) => {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0)
        throw new DomainError('invalid_workbook', 'יש לבחור קובץ XLSX לייבוא');
      transfers.replaceWithReset(await parseResetWorkbook(req.body));
      res.status(204).end();
    }),
  );
  api.post(
    '/workbook/recovery',
    requireRole('admin'),
    (req, _res, next) => {
      if (req.header('x-mapatz-confirmed') !== 'true')
        return next(
          new DomainError(
            'confirmation_required',
            'יש לאשר במפורש את החלפת המלאי הקיים בשחזור לפני הייבוא',
            400,
          ),
        );
      next();
    },
    express.raw({ type: WORKBOOK_CONTRACT.mimeType, limit: '10mb' }),
    route(async (req, res) => {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0)
        throw new DomainError('invalid_workbook', 'יש לבחור קובץ XLSX לשחזור');
      transfers.replaceWithRecovery(await parseRecoveryWorkbook(req.body));
      res.status(204).end();
    }),
  );
  api.post(
    '/stock/add',
    requireRole('admin'),
    route((req, res) => {
      const body = parse(
        z.object({ itemId: positive, quantity: positive, note: z.string().max(500).optional() }),
        req.body,
      );
      res.status(201).json({ eventId: service.addStock(body.itemId, body.quantity, body.note) });
    }),
  );
  api.post(
    '/stock/remove',
    requireRole('admin'),
    route((req, res) => {
      const body = parse(
        z.object({ itemId: positive, quantity: positive, note: z.string().max(500).optional() }),
        req.body,
      );
      res.status(201).json({ eventId: service.removeStock(body.itemId, body.quantity, body.note) });
    }),
  );
  api.post(
    '/issue',
    requireRole('operator', 'admin'),
    route((req, res) => {
      const body = parse(
        z
          .object({ itemId: positive, quantity: positive, note: z.string().max(500).optional() })
          .strict(),
        req.body,
      );
      res.status(201).json({ eventId: service.issue(body.itemId, body.quantity, body.note) });
    }),
  );
  api.post(
    '/checkout',
    requireRole('operator', 'admin'),
    route((req, res) => {
      const body = parse(
        z.object({
          itemId: positive,
          borrowerId: positive,
          quantity: positive,
          note: z.string().max(500).optional(),
        }),
        req.body,
      );
      res.status(201).json({
        eventId: service.checkout(body.itemId, body.borrowerId, body.quantity, body.note),
      });
    }),
  );
  api.post(
    '/return',
    requireRole('operator', 'admin'),
    route((req, res) => {
      const body = parse(
        z.object({
          checkoutId: positive,
          usable: z.number().int().min(0),
          damaged: z.number().int().min(0),
          note: z.string().max(500).optional(),
        }),
        req.body,
      );
      res.status(201).json({
        eventIds: service.returnCheckout(body.checkoutId, body.usable, body.damaged, body.note),
      });
    }),
  );
  api.post(
    '/lost',
    requireRole('admin'),
    route((req, res) => {
      const body = parse(
        z.object({
          checkoutId: positive,
          quantity: positive,
          lost: z.boolean(),
          note: z.string().max(500).optional(),
        }),
        req.body,
      );
      res
        .status(201)
        .json({ eventId: service.markLost(body.checkoutId, body.quantity, body.lost, body.note) });
    }),
  );
  api.post(
    '/damage',
    requireRole('admin'),
    route((req, res) => {
      const body = parse(
        z.object({
          itemId: positive,
          quantity: positive,
          resolution: z.enum(['repair', 'write_off']),
          note: z.string().max(500).optional(),
        }),
        req.body,
      );
      res.status(201).json({
        eventId: service.resolveDamage(
          body.itemId,
          body.quantity,
          body.resolution === 'repair',
          body.note,
        ),
      });
    }),
  );
  api.post(
    '/password',
    requireRole('admin'),
    route((req, res) => {
      const body = parse(
        z.object({ role: z.enum(['operator', 'admin']), password: z.string().min(8).max(200) }),
        req.body,
      );
      sessions.changePassword(body.role, body.password);
      res.status(204).end();
    }),
  );

  return api;
}
