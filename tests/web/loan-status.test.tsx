// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoanStatus } from '../../src/web/LoanStatus';
import { api } from '../../src/web/api';

vi.mock('../../src/web/api', () => ({ api: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const loans = [
  {
    checkoutId: 1,
    itemName: 'פטיש',
    borrowerName: 'דנה',
    outstanding: 2,
    createdAt: '2026-10-15 22:30:00',
  },
  {
    checkoutId: 2,
    itemName: 'אוהל',
    borrowerName: 'Alex',
    outstanding: 1,
    createdAt: '2026-09-04 12:00:00',
  },
  {
    checkoutId: 3,
    itemName: 'אבוד בלבד',
    borrowerName: 'דן',
    outstanding: 0,
    lost: 1,
    createdAt: '2026-10-15 12:00:00',
  },
];

describe('outstanding loan status', () => {
  it('shows outstanding checkouts separately, newest first, using Israel calendar dates', async () => {
    vi.mocked(api).mockResolvedValue([
      ...loans,
      { ...loans[0], checkoutId: 4, createdAt: '2026-10-14 10:00:00' },
      { ...loans[0], checkoutId: 5, itemName: 'הוחזר', outstanding: 0 },
    ]);
    render(<LoanStatus showToast={vi.fn()} />);
    expect(screen.getByRole('status').textContent).toContain('טוען');
    const table = await screen.findByRole('table');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual(['פריט', 'שואל', 'תאריך השאלה']);
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => within(row).getAllByRole('cell')[2]!.textContent)).toEqual([
      '16.10.2026',
      '14.10.2026',
      '04.09.2026',
    ]);
    expect(screen.queryByText('אבוד בלבד')).toBeNull();
    expect(screen.queryByText('הוחזר')).toBeNull();
    expect(api).toHaveBeenCalledWith('/loans');
  });

  it.each([
    ['  פטי  ', 'דנה'],
    ['alex', 'Alex'],
    ['16.10.2026', 'דנה'],
    ['16/10/2026', 'דנה'],
    ['2026-10-16', 'דנה'],
    ['09.2026', 'Alex'],
  ])('filters by item, borrower, and local borrow date: %s', async (query, borrower) => {
    vi.mocked(api).mockResolvedValue(loans);
    render(<LoanStatus showToast={vi.fn()} />);
    fireEvent.change(await screen.findByRole('textbox', { name: 'סינון הטבלה' }), {
      target: { value: query },
    });
    const rows = within(screen.getByRole('table')).getAllByRole('row');
    expect(rows).toHaveLength(2);
    expect(within(rows[1]!).getByText(borrower)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'ניקוי סינון' }));
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(3);
  });

  it('reports a load failure through a toast and retries without pretending there are no loans', async () => {
    const showToast = vi.fn();
    vi.mocked(api).mockRejectedValueOnce(new Error('אין חיבור')).mockResolvedValueOnce([]);
    render(<LoanStatus showToast={showToast} />);
    const retry = await screen.findByRole('button', { name: 'ניסיון טעינה מחדש' });
    expect(showToast).toHaveBeenCalledWith('טעינת מצב השאלות', 'אין חיבור', 'error');
    expect(screen.queryByRole('table')).toBeNull();
    fireEvent.click(retry);
    expect(await screen.findByText('לא נמצאו השאלות להצגה')).toBeTruthy();
  });

  it('refreshes balances explicitly and on re-entry', async () => {
    vi.mocked(api)
      .mockResolvedValueOnce(loans)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(loans);
    const showToast = vi.fn();
    const view = render(<LoanStatus showToast={showToast} />);
    await screen.findByText('דנה');
    fireEvent.click(screen.getByRole('button', { name: 'רענון' }));
    await screen.findByText('לא נמצאו השאלות להצגה');
    view.unmount();
    render(<LoanStatus showToast={showToast} />);
    await screen.findByText('דנה');
    expect(api).toHaveBeenCalledTimes(3);
  });

  it('preserves the search, sorting, and page size through refresh', async () => {
    vi.mocked(api).mockResolvedValue(loans);
    render(<LoanStatus showToast={vi.fn()} />);
    const search = await screen.findByRole('textbox', { name: 'סינון הטבלה' });
    fireEvent.change(search, { target: { value: 'דנה' } });
    fireEvent.click(screen.getByRole('button', { name: 'תאריך השאלה' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'שורות בעמוד' }), {
      target: { value: '25' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'רענון' }));
    await screen.findByRole('table');
    expect(screen.getByRole('textbox', { name: 'סינון הטבלה' })).toHaveProperty('value', 'דנה');
    expect(screen.queryByRole('cell', { name: 'Alex' })).toBeNull();
    expect(
      screen.getByRole('columnheader', { name: 'תאריך השאלה' }).getAttribute('aria-sort'),
    ).toBe('ascending');
    expect(screen.getByRole('combobox', { name: 'שורות בעמוד' })).toHaveProperty('value', '25');
  });

  it('ignores late failures after leaving the view', async () => {
    let reject!: (error: Error) => void;
    vi.mocked(api).mockReturnValue(
      new Promise((_resolve, rejectRequest) => {
        reject = rejectRequest;
      }),
    );
    const showToast = vi.fn();
    const view = render(<LoanStatus showToast={showToast} />);
    view.unmount();
    await act(async () => reject(new Error('late error')));
    expect(showToast).not.toHaveBeenCalled();
  });
});
