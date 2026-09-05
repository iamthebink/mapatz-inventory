import ExcelJS, { type CellValue, type Worksheet } from 'exceljs';
import {
  type InventoryTransferSnapshot,
  type ResetItem,
  type ResetPayload,
  type TransferLocation,
} from '../domain/import-export.js';
import { DomainError, type ItemKind } from '../domain/types.js';
import { WORKBOOK_CONTRACT, type WorkbookSheetKey } from './workbook-contract.js';

type Primitive = string | number | boolean | null | undefined;

function importError(message: string): never {
  throw new DomainError('invalid_workbook', message);
}

function addSheet(workbook: ExcelJS.Workbook, key: WorkbookSheetKey, rows: Primitive[][]): void {
  const definition = WORKBOOK_CONTRACT.sheets[key];
  const sheet = workbook.addWorksheet(definition.name, { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.addRow([...definition.columns]);
  for (const row of rows) sheet.addRow(row);
  sheet.getRow(1).font = { bold: true };
  sheet.autoFilter = { from: 'A1', to: sheet.getRow(1).getCell(definition.columns.length).address };
  definition.columns.forEach((column, index) => {
    sheet.getColumn(index + 1).width = Math.max(12, column.length + 2);
  });
}

export async function exportWorkbook(snapshot: InventoryTransferSnapshot): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Mapatz Inventory';
  workbook.company = 'Mapatz';
  addSheet(
    workbook,
    'resetLocations',
    snapshot.locations.map((location) => [location.name, location.archived]),
  );
  addSheet(
    workbook,
    'resetItems',
    snapshot.items.map((item) => [
      item.code,
      item.name,
      item.kind,
      item.location,
      JSON.stringify(item.aliases),
      item.lotSize,
      item.archived,
      item.resetTotal,
    ]),
  );
  addSheet(
    workbook,
    'recoveryLocations',
    snapshot.locations.map((location) => [location.name, location.archived]),
  );
  addSheet(
    workbook,
    'recoveryItems',
    snapshot.items.map((item) => [
      item.code,
      item.name,
      item.kind,
      item.location,
      JSON.stringify(item.aliases),
      item.lotSize,
      item.archived,
      item.createdAt,
      item.startingStock,
      item.baselineThroughEventId,
    ]),
  );
  addSheet(
    workbook,
    'recoveryBorrowers',
    snapshot.borrowers.map((borrower) => [
      borrower.username,
      borrower.name,
      borrower.contact,
      borrower.type,
      borrower.archived,
      borrower.createdAt,
    ]),
  );
  addSheet(
    workbook,
    'recoveryEvents',
    snapshot.events.map((event) => [
      event.id,
      event.kind,
      event.itemCode,
      event.borrowerUsername,
      event.quantity,
      event.relatedEventId,
      event.note,
      event.createdAt,
    ]),
  );
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function primitive(value: CellValue): Primitive {
  if (
    value == null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
    return value;
  return importError('Workbook cells must contain plain text, numbers, booleans, or blanks');
}

function isBlank(value: Primitive): boolean {
  return value == null || (typeof value === 'string' && value.trim() === '');
}

function requiredText(value: Primitive, context: string, maximum = 100): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > maximum)
    return importError(`${context} must be nonblank text of at most ${maximum} characters`);
  return value.trim();
}

function optionalText(value: Primitive, context: string): string | null {
  return isBlank(value) ? null : requiredText(value, context);
}

function integer(value: Primitive, context: string, minimum?: number): number {
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (
    typeof parsed !== 'number' ||
    !Number.isSafeInteger(parsed) ||
    (minimum != null && parsed < minimum)
  )
    return importError(`${context} must be ${minimum === 0 ? 'a nonnegative' : 'a whole'} number`);
  return parsed;
}

function optionalInteger(value: Primitive, context: string, minimum?: number): number | null {
  return isBlank(value) ? null : integer(value, context, minimum);
}

function optionalBoolean(value: Primitive, context: string): boolean {
  if (isBlank(value)) return false;
  if (typeof value === 'boolean') return value;
  if (value === 1 || (typeof value === 'string' && value.trim().toLowerCase() === 'true'))
    return true;
  if (value === 0 || (typeof value === 'string' && value.trim().toLowerCase() === 'false'))
    return false;
  return importError(`${context} must be TRUE, FALSE, 1, 0, or blank`);
}

function aliases(value: Primitive, context: string): string[] {
  if (isBlank(value)) return [];
  if (typeof value !== 'string')
    return importError(`${context} must be a JSON array of text aliases`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return importError(`${context} must be a JSON array, for example ["alias"]`);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length > 20 ||
    parsed.some(
      (alias) => typeof alias !== 'string' || alias.trim().length < 1 || alias.trim().length > 100,
    )
  )
    return importError(`${context} must contain at most 20 nonblank text aliases`);
  const normalized = parsed.map((alias) => alias.trim());
  const unique = new Set(normalized.map((alias) => alias.toLocaleLowerCase()));
  if (unique.size !== normalized.length)
    return importError(`${context} contains duplicate aliases`);
  return normalized;
}

function requiredSheet(workbook: ExcelJS.Workbook, key: WorkbookSheetKey): Worksheet {
  const definition = WORKBOOK_CONTRACT.sheets[key];
  const sheet = workbook.getWorksheet(definition.name);
  if (!sheet) return importError(`Missing required sheet "${definition.name}"`);
  const actual = Array.from({ length: definition.columns.length }, (_, index) =>
    primitive(sheet.getRow(1).getCell(index + 1).value),
  );
  const trailingHeaders = Array.from(
    { length: Math.max(0, sheet.getRow(1).cellCount - definition.columns.length) },
    (_, index) => primitive(sheet.getRow(1).getCell(definition.columns.length + index + 1).value),
  );
  if (
    actual.some((value, index) => value !== definition.columns[index]) ||
    trailingHeaders.some((value) => !isBlank(value))
  )
    return importError(
      `Sheet "${definition.name}" must use the exact exported columns in their original order`,
    );
  return sheet;
}

function dataRows(sheet: Worksheet, width: number): Primitive[][] {
  const rows: Primitive[][] = [];
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = Array.from({ length: width }, (_, index) =>
      primitive(sheet.getRow(rowNumber).getCell(index + 1).value),
    );
    if (!row.every(isBlank)) rows.push(row);
  }
  return rows;
}

export async function parseResetWorkbook(buffer: Buffer): Promise<ResetPayload> {
  const workbook = new ExcelJS.Workbook();
  try {
    const bytes = buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    ) as ArrayBuffer;
    await workbook.xlsx.load(bytes);
  } catch {
    return importError('The uploaded file is not a readable XLSX workbook');
  }
  const locationSheet = requiredSheet(workbook, 'resetLocations');
  const itemSheet = requiredSheet(workbook, 'resetItems');
  const locations: TransferLocation[] = dataRows(locationSheet, 2).map((row, index) => ({
    name: requiredText(row[0], `Reset Locations row ${index + 2} Name`),
    archived: optionalBoolean(row[1], `Reset Locations row ${index + 2} Archived`),
  }));
  const locationNames = new Map<string, string>();
  for (const location of locations) {
    const key = location.name.toLocaleLowerCase();
    if (locationNames.has(key))
      return importError(`Reset Locations contains duplicate name "${location.name}"`);
    locationNames.set(key, location.name);
  }
  const rawItems = dataRows(itemSheet, 8);
  const usedCodes = new Set<number>();
  const blankCodeRows: number[] = [];
  const items: Array<Omit<ResetItem, 'code'> & { code?: number }> = [];
  rawItems.forEach((row, index) => {
    const rowNumber = index + 2;
    const suppliedCode = optionalInteger(row[0], `Reset Items row ${rowNumber} Item Code`);
    if (suppliedCode != null) {
      if (usedCodes.has(suppliedCode))
        return importError(`Reset Items contains duplicate Item Code ${suppliedCode}`);
      usedCodes.add(suppliedCode);
    } else blankCodeRows.push(index);
    const kind = requiredText(row[2], `Reset Items row ${rowNumber} Kind`) as ItemKind;
    if (kind !== 'consumable' && kind !== 'non_consumable')
      return importError(`Reset Items row ${rowNumber} Kind must be consumable or non_consumable`);
    const locationInput = optionalText(row[3], `Reset Items row ${rowNumber} Location`);
    const location =
      locationInput == null
        ? null
        : (locationNames.get(locationInput.toLocaleLowerCase()) ??
          importError(
            `Reset Items row ${rowNumber} references unknown Location "${locationInput}"`,
          ));
    const lotSize = optionalInteger(row[5], `Reset Items row ${rowNumber} Lot Size`, 1);
    if (kind === 'non_consumable' && lotSize != null)
      return importError(`Reset Items row ${rowNumber} Lot Size is only valid for consumables`);
    items.push({
      ...(suppliedCode == null ? {} : { code: suppliedCode }),
      name: requiredText(row[1], `Reset Items row ${rowNumber} Name`),
      kind,
      location,
      aliases: aliases(row[4], `Reset Items row ${rowNumber} Aliases`),
      lotSize,
      archived: optionalBoolean(row[6], `Reset Items row ${rowNumber} Archived`),
      total: integer(row[7], `Reset Items row ${rowNumber} Total`, 0),
    });
  });
  let nextCode = 100;
  for (const index of blankCodeRows) {
    while (usedCodes.has(nextCode)) nextCode += 1;
    items[index]!.code = nextCode;
    usedCodes.add(nextCode);
    nextCode += 1;
  }
  return { locations, items: items as ResetItem[] };
}
