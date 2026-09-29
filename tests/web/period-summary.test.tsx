// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PeriodSummary } from '../../src/web/PeriodSummary';
import { fetchPeriodSummary } from '../../src/web/api';
import { todayInIsrael } from '../../src/domain/period-summary';
import type { PeriodSummary as Result } from '../../src/contracts/period-summary';

vi.mock('../../src/web/api', () => ({ fetchPeriodSummary: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});

const borrower = (id: number, name: string) => ({
  id,
  name,
  username: `user-${id}`,
  contact: id === 1 ? '050' : '',
  type: 'individual' as const,
  archived: id === 2,
});
const result: Result = {
  start: '2026-09-21',
  end: '2026-09-21',
  borrowers: [
    {
      borrower: borrower(1, 'אלף'),
      total: 2,
      items: [{ itemId: 1, code: 100, name: 'כיסא', quantity: 2 }],
    },
    {
      borrower: borrower(2, 'בית'),
      total: 3,
      items: [{ itemId: 2, code: 101, name: 'מקדחה', quantity: 3 }],
    },
  ],
};

function view(returnRevision = 0) {
  const openCard = vi.fn();
  const showToast = vi.fn();
  const rendered = render(
    <PeriodSummary
      active
      returnRevision={returnRevision}
      openCard={openCard}
      showToast={showToast}
    />,
  );
  return { ...rendered, openCard, showToast };
}

describe('period summary view', () => {
  it('searches current borrower metadata and keeps multiple accordion rows open', async () => {
    vi.mocked(fetchPeriodSummary).mockResolvedValue(result);
    const { openCard } = view();
    await screen.findByText('אלף');
    const firstRow = screen.getByText('אלף').closest('tr')!;
    const firstToggle = within(firstRow).getByRole('button', { name: 'הצגת ציוד של אלף' });
    expect(firstToggle.closest('td')).toBe(firstRow.querySelector('td'));
    expect(
      within(firstRow)
        .getByRole('button', { name: 'פתיחת כרטיס שואל — אלף' })
        .classList.contains('borrower-directory-action'),
    ).toBe(true);
    expect(screen.queryByRole('columnheader', { name: 'פעולות' })).toBeNull();
    fireEvent.click(firstToggle);
    fireEvent.click(screen.getByRole('button', { name: 'הצגת ציוד של בית' }));
    expect(
      screen.getByRole('button', { name: 'הסתרת ציוד של אלף' }).getAttribute('aria-expanded'),
    ).toBe('true');
    expect(
      screen.getByRole('button', { name: 'הסתרת ציוד של בית' }).getAttribute('aria-expanded'),
    ).toBe('true');
    expect(screen.getByText('כיסא')).toBeTruthy();
    expect(screen.getByText('מקדחה')).toBeTruthy();
    fireEvent.change(screen.getByRole('searchbox', { name: 'חיפוש שואל' }), {
      target: { value: '050' },
    });
    expect(screen.getByText('אלף')).toBeTruthy();
    expect(screen.queryByText('בית')).toBeNull();
    fireEvent.change(screen.getByRole('searchbox', { name: 'חיפוש שואל' }), {
      target: { value: 'user-2' },
    });
    expect(screen.queryByText('אלף')).toBeNull();
    const row = screen.getByText('בית').closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: 'פתיחת כרטיס שואל — בית' }));
    expect(openCard).toHaveBeenCalledWith(expect.objectContaining({ id: 2, archived: true }));
    expect(screen.getByRole('searchbox', { name: 'חיפוש שואל' }).getAttribute('value')).toBe(
      'user-2',
    );
  });

  it('distinguishes loading, empty, search-empty and failed retrieval with retry', async () => {
    let resolve!: (value: Result) => void;
    vi.mocked(fetchPeriodSummary).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const { showToast } = view();
    expect(screen.getByText('טוען סיכום…')).toBeTruthy();
    resolve(result);
    await screen.findByText('אלף');
    fireEvent.change(screen.getByRole('searchbox', { name: 'חיפוש שואל' }), {
      target: { value: 'missing' },
    });
    expect(screen.getByText('אין שואלים התואמים לחיפוש.')).toBeTruthy();
    vi.mocked(fetchPeriodSummary).mockResolvedValueOnce({ ...result, borrowers: [] });
    const refresh = screen.getByRole('button', { name: 'רענון' });
    expect(refresh.classList.contains('secondary-button')).toBe(true);
    expect(refresh.querySelector('svg')).not.toBeNull();
    fireEvent.click(refresh);
    expect(await screen.findByText('אין יתרות השאלה חיוביות בתקופה זו.')).toBeTruthy();
    vi.mocked(fetchPeriodSummary).mockRejectedValueOnce(new Error('offline'));
    fireEvent.click(screen.getByRole('button', { name: 'רענון' }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('טעינת סיכום', 'offline', 'error'));
    expect(screen.queryByText('אין יתרות השאלה חיוביות בתקופה זו.')).toBeNull();
    expect(screen.getByRole('searchbox', { name: 'חיפוש שואל' }).getAttribute('value')).toBe(
      'missing',
    );
  });

  it('never displays a stale result after a newer date request', async () => {
    let resolveOld!: (value: Result) => void;
    vi.mocked(fetchPeriodSummary).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolveOld = done;
        }),
    );
    vi.mocked(fetchPeriodSummary).mockResolvedValueOnce({
      ...result,
      borrowers: [result.borrowers[1]!],
    });
    view();
    fireEvent.change(screen.getByLabelText('מתאריך'), { target: { value: '2026-09-21' } });
    // The end remains today, so the edited range is valid.
    expect(await screen.findByText('בית')).toBeTruthy();
    resolveOld({ ...result, borrowers: [result.borrowers[0]!] });
    await waitFor(() => expect(screen.queryByText('אלף')).toBeNull());
    expect(vi.mocked(fetchPeriodSummary).mock.calls[1]?.[0]).toBe('2026-09-21');
  });

  it('invalidates the old request inside the date handler before the next effect runs', async () => {
    let resolveOld!: (value: Result) => void;
    let resolveNew!: (value: Result) => void;
    vi.mocked(fetchPeriodSummary)
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolveOld = done;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolveNew = done;
          }),
      );
    view();
    await act(async () => {
      fireEvent.change(screen.getByLabelText('מתאריך'), { target: { value: '2026-09-21' } });
      resolveOld({ ...result, borrowers: [result.borrowers[0]!] });
      await Promise.resolve();
    });
    expect(screen.queryByText('אלף')).toBeNull();
    expect(screen.getByText('טוען סיכום…')).toBeTruthy();
    resolveNew({ ...result, borrowers: [result.borrowers[1]!] });
    expect(await screen.findByText('בית')).toBeTruthy();
    expect(screen.queryByText('אלף')).toBeNull();
  });

  it('rejects invalid selections while retaining the last valid range', async () => {
    vi.mocked(fetchPeriodSummary).mockResolvedValue(result);
    const { showToast } = view();
    await screen.findByText('אלף');
    const priorCalls = vi.mocked(fetchPeriodSummary).mock.calls.length;
    fireEvent.change(screen.getByLabelText('עד תאריך'), { target: { value: '2099-01-01' } });
    expect(showToast).toHaveBeenCalledWith('טווח תאריכים', expect.any(String), 'warning');
    expect(vi.mocked(fetchPeriodSummary).mock.calls).toHaveLength(priorCalls);
    expect((screen.getByLabelText('עד תאריך') as HTMLInputElement).value).toBe(todayInIsrael());
  });

  it('advances today-only after a suspended midnight and keeps an explicit historical range fixed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-23T20:59:59Z'));
    vi.mocked(fetchPeriodSummary).mockResolvedValue(result);
    const first = view();
    await screen.findByText('אלף');
    expect((screen.getByLabelText('מתאריך') as HTMLInputElement).value).toBe('2026-09-23');
    act(() => {
      vi.setSystemTime(new Date('2026-09-23T21:00:01Z'));
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() =>
      expect((screen.getByLabelText('מתאריך') as HTMLInputElement).value).toBe('2026-09-24'),
    );
    expect((screen.getByLabelText('עד תאריך') as HTMLInputElement).value).toBe('2026-09-24');
    expect(vi.mocked(fetchPeriodSummary).mock.lastCall).toEqual(['2026-09-24', '2026-09-24']);

    first.unmount();
    vi.setSystemTime(new Date('2026-09-24T20:59:59Z'));
    view();
    await screen.findByText('אלף');
    fireEvent.change(screen.getByLabelText('מתאריך'), { target: { value: '2026-09-21' } });
    fireEvent.change(screen.getByLabelText('עד תאריך'), { target: { value: '2026-09-22' } });
    await waitFor(() =>
      expect(vi.mocked(fetchPeriodSummary).mock.lastCall).toEqual(['2026-09-21', '2026-09-22']),
    );
    const callCount = vi.mocked(fetchPeriodSummary).mock.calls.length;
    act(() => {
      vi.setSystemTime(new Date('2026-09-24T21:00:01Z'));
      window.dispatchEvent(new Event('focus'));
    });
    expect((screen.getByLabelText('מתאריך') as HTMLInputElement).value).toBe('2026-09-21');
    expect((screen.getByLabelText('עד תאריך') as HTMLInputElement).value).toBe('2026-09-22');
    expect(vi.mocked(fetchPeriodSummary).mock.calls).toHaveLength(callCount);
  });
});
