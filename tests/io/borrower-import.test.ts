import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { parseBorrowerWorkbook } from '../../src/io/workbook.js';

async function workbook(rows: ExcelJS.CellValue[][]) {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('People');
  sheet.addRow(['Username', 'Name', 'Contact', 'Type']);
  rows.forEach((row) => sheet.addRow(row));
  book.addWorksheet('Ignored').addRow(['not borrowers']);
  return Buffer.from(await book.xlsx.writeBuffer());
}

describe('standalone borrower workbook', () => {
  it('reads the first worksheet and defaults optional fields', async () => {
    expect(await parseBorrowerWorkbook(await workbook([[' user ', ' Person ']]))).toEqual([
      { username: 'user', name: 'Person', contact: '', type: 'individual' },
    ]);
  });
  it.each([
    [
      ['ok', 'Good'],
      ['bad', '', '', 'individual'],
    ],
    [
      ['ok', 'Good'],
      ['bad', 'Bad', '', 'invalid'],
    ],
    [
      ['ok', 'Good'],
      ['bad', 'Bad', 'x'.repeat(501)],
    ],
    [
      ['ok', 'Good'],
      ['bad', 'Bad', '', '', 'unexpected'],
    ],
    [
      ['ok', 'Good'],
      ['bad', { formula: '1+1', result: 2 }],
    ],
    [
      ['ok', 'Good'],
      ['ＯＫ', 'Duplicate'],
    ],
    [['x', 'Short username']],
  ])('rejects all rows on invalid input %j', async (...rows) => {
    await expect(parseBorrowerWorkbook(await workbook(rows))).rejects.toThrow();
  });
  it('reports physical row numbers across blanks', async () => {
    await expect(
      parseBorrowerWorkbook(await workbook([['ok', 'Good'], [], ['bad', '']])),
    ).rejects.toThrow('Row 4 Name');
  });
  it('rejects empty and malformed workbooks and missing headers', async () => {
    await expect(parseBorrowerWorkbook(await workbook([]))).rejects.toThrow('at least one');
    await expect(parseBorrowerWorkbook(Buffer.from('invalid'))).rejects.toThrow('readable XLSX');
    const book = new ExcelJS.Workbook();
    book.addWorksheet('Wrong').addRow(['Name', 'Username']);
    await expect(parseBorrowerWorkbook(Buffer.from(await book.xlsx.writeBuffer()))).rejects.toThrow(
      'Row 1',
    );
  });
});
