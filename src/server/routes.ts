import express, { Router, type RequestHandler } from 'express';
import { z, type ZodType } from 'zod';
import type {
  BorrowerCreateRequest,
  BorrowerCreateResult,
  BorrowerDeskSnapshot,
  BorrowerOperationRequest,
  BorrowerOperationResult,
  BorrowerSearchSnapshot,
  CommandProtocolError,
  ValidationFieldError,
} from '../contracts/borrower-workflow.js';
import type { InventoryService } from '../domain/inventory.js';
import type { InventoryTransferService } from '../domain/import-export.js';
import type { RadioService } from '../domain/radios.js';
import { DomainError, type Role } from '../domain/types.js';
import {
  exportWorkbook,
  parseRecoveryWorkbook,
  parseResetWorkbook,
  parseBorrowerWorkbook,
} from '../io/workbook.js';
import { WORKBOOK_CONTRACT } from '../io/workbook-contract.js';
import type { SessionStore } from './session.js';

const positive = z.number().int().positive();
const safePositive = z.number().int().positive();
const id = z.coerce.number().int().positive();
const commandRouteId = z.coerce.number().int().positive();
const aliases = z.array(z.string().trim().min(1).max(100)).max(20);
const itemInput = z.object({
  name: z.string().trim().min(1).max(100),
  kind: z.enum(['consumable', 'non_consumable', 'camp_equipment']),
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
const note = z.string().max(500).default('');
const borrowerOperationInput = z
  .object({
    contractVersion: z.literal(1),
    ledgerEpoch: safePositive,
    items: z
      .array(
        z
          .object({
            itemId: safePositive,
            borrow: z
              .array(z.object({ quantity: safePositive, note }).strict())
              .min(1)
              .optional(),
            issue: z
              .array(z.object({ quantity: safePositive, note }).strict())
              .min(1)
              .optional(),
            return: z
              .array(
                z
                  .object({
                    usable: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
                    damaged: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
                    note,
                  })
                  .strict()
                  .refine((part) => part.usable + part.damaged > 0, {
                    message: 'A return part must return at least one item',
                  }),
              )
              .min(1)
              .optional(),
            lost: z
              .array(z.object({ quantity: safePositive, note }).strict())
              .min(1)
              .optional(),
            lostCredit: z
              .array(
                z
                  .object({
                    quantity: safePositive,
                    condition: z.enum(['usable', 'damaged']),
                    note,
                  })
                  .strict(),
              )
              .min(1)
              .optional(),
          })
          .strict()
          .refine(
            (group) =>
              group.borrow !== undefined ||
              group.issue !== undefined ||
              group.return !== undefined ||
              group.lost !== undefined ||
              group.lostCredit !== undefined,
            {
              message: 'An item group must include borrow, return, lost, or lost-credit parts',
            },
          ),
      )
      .min(1),
  })
  .strict()
  .superRefine((request, context) => {
    const seen = new Set<number>();
    const commandBorrow: number[] = [];
    const commandIssue: number[] = [];
    const commandReturn: number[] = [];
    const commandHeld: number[] = [];
    const commandUsable: number[] = [];
    const commandLost: number[] = [];
    const commandLostCredit: number[] = [];
    request.items.forEach((group, index) => {
      if (seen.has(group.itemId))
        context.addIssue({
          code: 'custom',
          path: ['items', index, 'itemId'],
          message: 'Item groups must have unique item IDs',
        });
      seen.add(group.itemId);
      const borrow = (group.borrow ?? []).map((part) => part.quantity);
      const issue = (group.issue ?? []).map((part) => part.quantity);
      const returned = (group.return ?? []).map((part) => part.usable + part.damaged);
      const usable = (group.return ?? []).map((part) => part.usable);
      const lost = (group.lost ?? []).map((part) => part.quantity);
      const lostCredit = (group.lostCredit ?? []).map((part) => part.quantity);
      const held = [...returned, ...lost];
      group.return?.forEach((part, partIndex) => {
        if (!Number.isSafeInteger(part.usable + part.damaged))
          context.addIssue({
            code: 'custom',
            path: ['items', index, 'return', partIndex],
            message: 'Return part total must be a safe integer',
          });
      });
      for (const [values, path, message] of [
        [borrow, 'borrow', 'Per-item borrow total must be a safe integer'],
        [issue, 'issue', 'Per-item issue total must be a safe integer'],
        [returned, 'return', 'Per-item return total must be a safe integer'],
        [usable, 'return', 'Per-item usable-return total must be a safe integer'],
        [lost, 'lost', 'Per-item lost total must be a safe integer'],
        [lostCredit, 'lostCredit', 'Per-item lost-credit total must be a safe integer'],
      ] as const)
        if (!isSafeAggregate(values))
          context.addIssue({ code: 'custom', path: ['items', index, path], message });
      if (!isSafeAggregate(held))
        context.addIssue({
          code: 'custom',
          path: ['items', index],
          message: 'Per-item held-consumption total must be a safe integer',
        });
      commandBorrow.push(...borrow);
      commandIssue.push(...issue);
      commandReturn.push(...returned);
      commandHeld.push(...held);
      commandUsable.push(...usable);
      commandLost.push(...lost);
      commandLostCredit.push(...lostCredit);
    });
    for (const [values, message] of [
      [commandBorrow, 'Command borrow total must be a safe integer'],
      [commandIssue, 'Command issue total must be a safe integer'],
      [commandReturn, 'Command return total must be a safe integer'],
      [commandHeld, 'Command held-consumption total must be a safe integer'],
      [commandUsable, 'Command usable-return total must be a safe integer'],
      [commandLost, 'Command lost total must be a safe integer'],
      [commandLostCredit, 'Command lost-credit total must be a safe integer'],
    ] as const)
      if (!isSafeAggregate(values)) context.addIssue({ code: 'custom', path: ['items'], message });
  });
const borrowerCreateInput = z
  .object({
    contractVersion: z.literal(1),
    ledgerEpoch: safePositive,
    username: z.string().trim().min(2).max(40),
    name: z.string().trim().min(1).max(100),
    contact: z.string().trim().max(500).default(''),
    type: z.enum(['individual', 'camp_organization', 'other']),
  })
  .strict();
const idempotencyKeyInput = z.uuid();

function isSafeAggregate(values: number[]): boolean {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) return false;
  }
  return true;
}

const parse = <T>(schema: ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new DomainError('validation_error', result.error.issues[0]?.message ?? 'Invalid input');
  return result.data;
};

function validationPath(pathSegments: PropertyKey[]): string {
  return pathSegments.reduce<string>(
    (path, segment) =>
      typeof segment === 'number'
        ? `${path}[${segment}]`
        : path.length === 0
          ? String(segment)
          : `${path}.${String(segment)}`,
    '',
  );
}

function validationErrors(issue: z.core.$ZodIssue): ValidationFieldError[] {
  if (issue.code === 'unrecognized_keys')
    return issue.keys.map((key) => ({
      field: validationPath([...issue.path, key]),
      code: issue.code,
      message: issue.message,
    }));
  return [{ field: validationPath(issue.path), code: issue.code, message: issue.message }];
}

function parseCommand<T>(
  schema: ZodType<T>,
  body: unknown,
  key: string | undefined,
):
  | { data: T; key: string }
  | { error: Extract<CommandProtocolError, { error: 'validation_error' }> } {
  const fieldErrors: ValidationFieldError[] = [];
  const keyResult = idempotencyKeyInput.safeParse(key);
  if (!keyResult.success)
    fieldErrors.push({
      field: 'Idempotency-Key',
      code: 'invalid_idempotency_key',
      message: 'Idempotency-Key must be a UUID',
    });
  const bodyResult = schema.safeParse(body);
  if (!bodyResult.success)
    for (const issue of bodyResult.error.issues) fieldErrors.push(...validationErrors(issue));
  if (fieldErrors.length > 0)
    return {
      error: {
        error: 'validation_error',
        message: 'The command transport is invalid',
        fieldErrors,
      },
    };
  return { data: bodyResult.data as T, key: keyResult.data as string };
}

function commandStatus(
  result: BorrowerOperationResult | BorrowerCreateResult | CommandProtocolError,
) {
  if ('outcome' in result && result.outcome === 'committed') return 201;
  return 409;
}

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
  desktopRecovery = false,
  radios?: RadioService,
): Router {
  const api = Router();
  const commandJson = express.json({ limit: '32kb' });

  if (radios) {
    const generation = z.number().int().positive();
    const radioId = z.coerce.number().int().positive();
    api.get(
      '/radios',
      requireRole('operator', 'admin'),
      route((_req, res) => res.json(radios.fleet())),
    );
    api.put(
      '/radios/count',
      requireRole('admin'),
      route((req, res) => {
        const body = parse(
          z.object({ count: z.number().int().min(0), generation }).strict(),
          req.body,
        );
        res.json(radios.setCount(body.count, body.generation));
      }),
    );
    api.put(
      '/radios/:number/custody',
      requireRole('operator', 'admin'),
      route((req, res) => {
        const number = parse(radioId, req.params.number);
        const body = parse(
          z
            .object({ generation, holder: z.string().trim().min(1), team: z.string().default('') })
            .strict(),
          req.body,
        );
        res.json(radios.custody(number, body.generation, body.holder, body.team));
      }),
    );
    api.post(
      '/radios/:number/return',
      requireRole('operator', 'admin'),
      route((req, res) => {
        const number = parse(radioId, req.params.number);
        const body = parse(z.object({ generation }).strict(), req.body);
        res.json(radios.returnRadio(number, body.generation));
      }),
    );
    api.post(
      '/radios/:number/lost',
      requireRole('operator', 'admin'),
      route((req, res) => {
        const number = parse(radioId, req.params.number);
        const body = parse(z.object({ generation }).strict(), req.body);
        res.json(radios.setLost(number, body.generation, true));
      }),
    );
    api.post(
      '/radios/:number/found',
      requireRole('operator', 'admin'),
      route((req, res) => {
        const number = parse(radioId, req.params.number);
        const body = parse(z.object({ generation }).strict(), req.body);
        res.json(radios.setLost(number, body.generation, false));
      }),
    );
  }

  if (desktopRecovery)
    api.post('/password/recovery', (_req, res) => {
      res.set('Cache-Control', 'no-store');
      const password = sessions.recoverPassword();
      if (password == null) {
        res.status(404).json({ error: 'not_found', message: 'Recovery unavailable' });
        return;
      }
      res.json({ password });
    });

  api.get('/session', (req, res) =>
    res.json({ role: res.locals.session.role, deadline: res.locals.session.deadline }),
  );
  api.post('/session/activity', (req, res) => {
    const session = sessions.touch(res.locals.session);
    res.json({ role: session.role, deadline: session.deadline });
  });
  api.post(
    '/session/role',
    route((req, res) => {
      const body = parse(
        z.object({ role: z.enum(['operator', 'admin']), password: z.string().optional() }),
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
  api.get('/inventory/epoch', (_req, res) => res.json({ ledgerEpoch: service.inventoryEpoch() }));
  const inventoryLocationSave = z
    .object({
      key: z.string().min(8).max(128),
      ledgerEpoch: positive,
      code: z.string().trim().min(1).max(40),
      name: z.string().trim().min(1).max(100),
      archived: z.boolean().optional(),
    })
    .strict();
  api.post(
    '/inventory/locations',
    requireRole('admin'),
    route((req, res) => {
      res
        .status(201)
        .json(
          service.saveInventoryLocation(
            parse(inventoryLocationSave.omit({ archived: true }), req.body),
          ),
        );
    }),
  );
  api.put(
    '/inventory/locations/:id',
    requireRole('admin'),
    route((req, res) => {
      res.json(
        service.saveInventoryLocation({
          ...parse(inventoryLocationSave, req.body),
          locationId: parse(id, req.params.id),
        }),
      );
    }),
  );
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
  const inventorySave = z
    .object({
      key: z.string().min(8).max(128),
      ledgerEpoch: positive,
      name: z.string().trim().min(1).max(100),
      kind: z.enum(['consumable', 'non_consumable', 'camp_equipment']).optional(),
      aliases: aliases.default([]),
      lotSize: positive.nullable(),
      locationId: positive.nullable(),
      targetAvailable: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
      stockRevision: z.number().int().min(0).optional(),
      note: z.string().max(500).optional(),
    })
    .strict();
  api.post(
    '/inventory/items',
    requireRole('admin'),
    route((req, res) => {
      res.status(201).json(service.saveInventoryItem(parse(inventorySave, req.body)));
    }),
  );
  api.put(
    '/inventory/items/:id',
    requireRole('admin'),
    route((req, res) => {
      res.json(
        service.saveInventoryItem({
          ...parse(inventorySave.omit({ kind: true }), req.body),
          itemId: parse(id, req.params.id),
        }),
      );
    }),
  );
  api.post(
    '/inventory/items/:id/archive',
    requireRole('admin'),
    route((req, res) => {
      const body = parse(
        z
          .object({
            key: z.string().min(8).max(128),
            ledgerEpoch: positive,
            archived: z.boolean(),
            locationId: positive.nullable().optional(),
          })
          .strict(),
        req.body,
      );
      res.json(service.archiveItemCommand({ ...body, itemId: parse(id, req.params.id) }));
    }),
  );
  api.post(
    '/inventory/damage',
    requireRole('operator', 'admin'),
    route((req, res) => {
      const body = parse(
        z
          .object({
            key: z.string().min(8).max(128),
            ledgerEpoch: positive,
            itemId: positive,
            quantity: positive,
            resolution: z.enum(['repair', 'write_off']),
            note: z.string().max(500).default(''),
          })
          .strict(),
        req.body,
      );
      if (
        body.resolution === 'write_off' &&
        (res.locals.session as { role: Role }).role !== 'admin'
      )
        throw new DomainError('forbidden', 'אין הרשאה לפעולה זו', 403);
      res.status(201).json(
        service.resolveDamageCommand({
          key: body.key,
          ledgerEpoch: body.ledgerEpoch,
          itemId: body.itemId,
          quantity: body.quantity,
          repaired: body.resolution === 'repair',
          note: body.note,
        }),
      );
    }),
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
      const body = parse(
        z.object({ archived: z.boolean(), locationId: positive.nullable().optional() }),
        req.body,
      );
      service.archiveItem(parse(id, req.params.id), body.archived, body.locationId);
      res.status(204).end();
    }),
  );

  api.get('/borrowers', (req, res) =>
    res.json(service.listBorrowers(String(req.query.q ?? ''), req.query.all === '1')),
  );
  api.get(
    '/borrowers/search',
    route((req, res) => {
      const snapshot: BorrowerSearchSnapshot = service.searchBorrowers(String(req.query.q ?? ''));
      res.json(snapshot);
    }),
  );
  api.get(
    '/borrowers/:id/desk-snapshot',
    route((req, res) => {
      const snapshot: BorrowerDeskSnapshot = service.getBorrowerDeskSnapshot(
        parse(id, req.params.id),
      );
      res.json(snapshot);
    }),
  );
  api.post(
    '/borrowers',
    requireRole('operator', 'admin'),
    commandJson,
    route((req, res) => {
      const parsed = parseCommand<BorrowerCreateRequest>(
        borrowerCreateInput,
        req.body,
        req.header('Idempotency-Key'),
      );
      if ('error' in parsed) return void res.status(400).json(parsed.error);
      const result = service.createBorrowerCommand(parsed.key, parsed.data);
      res.status(commandStatus(result)).json(result);
    }),
  );
  api.post(
    '/borrowers/:id/operations',
    requireRole('operator', 'admin'),
    commandJson,
    route((req, res) => {
      const routeId = commandRouteId.safeParse(req.params.id);
      const parsed = parseCommand<BorrowerOperationRequest>(
        borrowerOperationInput,
        req.body,
        req.header('Idempotency-Key'),
      );
      if (!routeId.success || 'error' in parsed) {
        const fieldErrors: ValidationFieldError[] = [];
        if (!routeId.success)
          fieldErrors.push({
            field: 'borrowerId',
            code: 'invalid_borrower_id',
            message: 'Borrower ID must be a positive integer',
          });
        if ('error' in parsed) fieldErrors.push(...parsed.error.fieldErrors);
        return void res.status(400).json({
          error: 'validation_error',
          message: 'The command transport is invalid',
          fieldErrors,
        });
      }
      const result = service.commitBorrowerOperations(routeId.data, parsed.key, parsed.data);
      res.status(commandStatus(result)).json(result);
    }),
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

  for (const operation of ['preview', 'commit'] as const) {
    api.post(
      `/borrowers/import/${operation}`,
      requireRole('admin'),
      express.raw({ type: WORKBOOK_CONTRACT.mimeType, limit: '10mb' }),
      route(async (req, res) => {
        const mode = parse(z.enum(['merge', 'replace']), req.query.mode);
        if (!Buffer.isBuffer(req.body) || req.body.length === 0)
          throw new DomainError('invalid_workbook', 'יש לבחור קובץ XLSX לייבוא');
        const rows = await parseBorrowerWorkbook(req.body);
        if (operation === 'preview') {
          res.json(service.previewBorrowerImport(rows, mode));
        } else {
          const token = parse(
            z.string().regex(/^[a-f0-9]{64}$/),
            req.header('x-borrower-import-confirmation'),
          );
          res.json(service.importBorrowers(rows, mode, token));
        }
      }),
    );
  }

  api.get('/loans', (req, res) => res.json(service.listLoans()));
  api.get(
    '/period-summary',
    requireRole('operator', 'admin'),
    route((req, res) => {
      const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
      const start = parse(date, req.query.start);
      const end = parse(date, req.query.end);
      res.json(service.periodSummary(start, end));
    }),
  );
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
    '/issue-batch',
    requireRole('operator', 'admin'),
    commandJson,
    route((req, res) => {
      const parsed = parseCommand(
        z
          .object({
            ledgerEpoch: safePositive,
            items: z
              .array(z.object({ itemId: safePositive, quantity: safePositive, note }).strict())
              .min(1),
          })
          .strict(),
        req.body,
        req.header('Idempotency-Key'),
      );
      if ('error' in parsed) return void res.status(400).json(parsed.error);
      const result = service.issueBatch({ key: parsed.key, ...parsed.data });
      res.status(result.outcome === 'committed' ? 201 : 409).json(result);
    }),
  );
  api.post(
    '/issue',
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
          lost: z.literal(true),
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
    requireRole('operator', 'admin'),
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
      if (
        body.resolution === 'write_off' &&
        (res.locals.session as { role: Role }).role !== 'admin'
      )
        throw new DomainError('forbidden', 'אין הרשאה לפעולה זו', 403);
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
      const body = parse(z.object({ password: z.string().min(1).max(200) }), req.body);
      sessions.changePassword(body.password);
      res.status(204).end();
    }),
  );

  return api;
}
