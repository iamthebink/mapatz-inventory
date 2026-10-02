import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { parseBorrowerWorkbook } from '../../src/io/workbook.js';

async function workbook(rows: ExcelJS.CellValue[][]) {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('People');
  sheet.addRow(['Playa Name', 'Full Name', 'Phone Number', 'Camp/Department']);
  rows.forEach((row) => sheet.addRow(row));
  book.addWorksheet('Ignored').addRow(['not borrowers']);
  return Buffer.from(await book.xlsx.writeBuffer());
}

describe('standalone borrower workbook', () => {
  it('reads the first worksheet and defaults optional fields', async () => {
    expect(await parseBorrowerWorkbook(await workbook([[' user ', ' Person ']]))).toEqual([
      { playaName: 'user', fullName: 'Person', phoneNumber: '', campDepartment: '' },
    ]);
  });
  it.each([
    [
      ['ok', 'Good'],
      ['bad', '', '', 'individual'],
    ],
    [
      ['ok', 'Good'],
      ['bad', 'Bad', '', 'x'.repeat(101)],
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
      ['ＯＫ', 'Good'],
    ],
    [['x', ' ']],
  ])('rejects all rows on invalid input %j', async (...rows) => {
    await expect(parseBorrowerWorkbook(await workbook(rows))).rejects.toThrow();
  });
  it('reports physical row numbers across blanks', async () => {
    await expect(
      parseBorrowerWorkbook(await workbook([['ok', 'Good'], [], ['bad', '']])),
    ).rejects.toThrow('Row 4 Full Name');
  });
  it('rejects empty and malformed workbooks and missing headers', async () => {
    await expect(parseBorrowerWorkbook(await workbook([]))).rejects.toThrow('at least one');
    await expect(parseBorrowerWorkbook(Buffer.from('invalid'))).rejects.toThrow('readable XLSX');
    const book = new ExcelJS.Workbook();
    book.addWorksheet('Wrong').addRow(['Name', 'PlayaName']);
    await expect(parseBorrowerWorkbook(Buffer.from(await book.xlsx.writeBuffer()))).rejects.toThrow(
      'Row 1',
    );
  });
});
