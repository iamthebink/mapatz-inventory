// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { RadioFleet } from '../../src/domain/types';
import { DialogStackProvider } from '../../src/web/Dialog';
import { Radios } from '../../src/web/Radios';
import { ApiError, fetchRadios, radioCommand } from '../../src/web/api';

vi.mock('../../src/web/api', async () => ({
  ...(await vi.importActual<typeof import('../../src/web/api')>('../../src/web/api')),
  fetchRadios: vi.fn(),
  radioCommand: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const fleet: RadioFleet = {
  count: 1,
  generation: 4,
  radios: [{ number: 1, holder: 'Alice', team: 'Old', lost: false }],
};

it('moves only faulty locations to the bottom, regardless of team, without mutating the fleet', async () => {
  const mixedFleet: RadioFleet = {
    ...fleet,
    count: 6,
    radios: [
      { number: 1, holder: 'תקול', team: 'Alpha', lost: false },
      { number: 2, holder: 'Alice', team: 'תקול', lost: false },
      { number: 3, holder: 'תקול', team: '', lost: true },
      { number: 4, holder: 'צוללת', team: '', lost: false },
      { number: 5, holder: 'תקול זמנית', team: '', lost: false },
      { number: 6, holder: 'תקול', team: 'Beta', lost: false },
    ],
  };
  vi.mocked(fetchRadios).mockResolvedValue(mixedFleet);
  render(
    <DialogStackProvider>
      <Radios active showToast={vi.fn()} />
    </DialogStackProvider>,
  );
  await screen.findByText('Alice');
  const rows = screen.getAllByRole('row').slice(1);
  expect(rows.map((row) => within(row).getAllByRole('cell')[0]!.textContent)).toEqual([
    '2',
    '4',
    '5',
    '1',
    '3',
    '6',
  ]);
  expect(rows.map((row) => row.classList.contains('radio-row-faulty'))).toEqual([
    false,
    false,
    false,
    true,
    true,
    true,
  ]);
  expect(mixedFleet.radios.map((radio) => radio.number)).toEqual([1, 2, 3, 4, 5, 6]);
  expect(within(rows[3]!).getAllByRole('cell')[3]!.textContent).toBe('תקול');
  expect(
    within(rows[3]!).getByRole('button', { name: 'עדכון מיקום' }).hasAttribute('disabled'),
  ).toBe(false);
  expect(within(rows[4]!).getByText('אבוד')).toBeTruthy();
  expect(
    within(rows[4]!).getByRole('button', { name: 'עדכון מיקום' }).hasAttribute('disabled'),
  ).toBe(true);
});

it.each(['return home', 'reassign'] as const)(
  'reorders and restyles a radio immediately after location updates and %s',
  async (recovery) => {
    const initialFleet: RadioFleet = {
      ...fleet,
      count: 2,
      radios: [fleet.radios[0]!, { number: 2, holder: 'Bob', team: '', lost: false }],
    };
    vi.mocked(fetchRadios).mockResolvedValue(initialFleet);
    vi.mocked(radioCommand)
      .mockResolvedValueOnce({
        ...initialFleet,
        radios: [{ ...initialFleet.radios[0]!, holder: 'תקול', team: '' }, initialFleet.radios[1]!],
      })
      .mockResolvedValueOnce({
        ...initialFleet,
        radios: [
          {
            ...initialFleet.radios[0]!,
            holder: recovery === 'return home' ? 'צוללת' : 'Carol',
            team: recovery === 'return home' ? '' : 'New',
          },
          initialFleet.radios[1]!,
        ],
      });
    render(
      <DialogStackProvider>
        <Radios active showToast={vi.fn()} />
      </DialogStackProvider>,
    );
    await screen.findByText('Alice');
    fireEvent.click(screen.getAllByRole('button', { name: 'עדכון מיקום' })[0]!);
    fireEvent.change(screen.getByRole('textbox', { name: 'מחזיק/ה' }), {
      target: { value: 'תקול' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'שמירה' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(
      screen
        .getAllByRole('row')
        .slice(1)
        .map((row) => within(row).getAllByRole('cell')[0]!.textContent),
    ).toEqual(['2', '1']);
    expect(screen.getAllByRole('row')[2]!.classList.contains('radio-row-faulty')).toBe(true);
    fireEvent.click(screen.getAllByRole('button', { name: 'עדכון מיקום' })[1]!);
    if (recovery === 'return home') {
      fireEvent.click(screen.getByRole('button', { name: 'החזרה לצוללת' }));
    } else {
      fireEvent.change(screen.getByRole('textbox', { name: 'מחזיק/ה' }), {
        target: { value: 'Carol' },
      });
      fireEvent.change(screen.getByRole('textbox', { name: 'צוות' }), {
        target: { value: 'New' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'שמירה' }));
    }
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(
      screen
        .getAllByRole('row')
        .slice(1)
        .map((row) => within(row).getAllByRole('cell')[0]!.textContent),
    ).toEqual(['1', '2']);
    expect(
      screen.getAllByRole('row').every((row) => !row.classList.contains('radio-row-faulty')),
    ).toBe(true);
    expect(within(screen.getAllByRole('row')[1]!).getByText('תקין')).toBeTruthy();
    if (recovery === 'reassign') {
      expect(radioCommand).toHaveBeenLastCalledWith('/radios/1/custody', 'PUT', {
        generation: 4,
        holder: 'Carol',
        team: 'New',
      });
      expect(within(screen.getAllByRole('row')[1]!).getByText('New')).toBeTruthy();
    }
  },
);

it('clears the previous team once and retains a newly entered team through later holder edits', async () => {
  vi.mocked(fetchRadios).mockResolvedValue(fleet);
  vi.mocked(radioCommand).mockResolvedValue(fleet);
  const showToast = vi.fn();
  render(
    <DialogStackProvider>
      <Radios active showToast={showToast} />
    </DialogStackProvider>,
  );
  const update = await screen.findByRole('button', { name: 'עדכון מיקום' });
  fireEvent.click(update);
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByDisplayValue('Old')).toBeTruthy();
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'מחזיק/ה' }), {
    target: { value: 'Bob' },
  });
  expect((within(dialog).getByRole('textbox', { name: 'צוות' }) as HTMLInputElement).value).toBe(
    '',
  );
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'צוות' }), {
    target: { value: 'New' },
  });
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'מחזיק/ה' }), {
    target: { value: 'Bobby' },
  });
  expect((within(dialog).getByRole('textbox', { name: 'צוות' }) as HTMLInputElement).value).toBe(
    'New',
  );
  fireEvent.click(within(dialog).getByRole('button', { name: 'שמירה' }));
  await waitFor(() =>
    expect(radioCommand).toHaveBeenCalledWith('/radios/1/custody', 'PUT', {
      generation: 4,
      holder: 'Bobby',
      team: 'New',
    }),
  );
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

it('offers lost and found actions and locks custody while lost', async () => {
  vi.mocked(fetchRadios).mockResolvedValue(fleet);
  vi.mocked(radioCommand)
    .mockResolvedValueOnce({ ...fleet, radios: [{ ...fleet.radios[0]!, lost: true }] })
    .mockResolvedValueOnce(fleet);
  render(
    <DialogStackProvider>
      <Radios active showToast={vi.fn()} />
    </DialogStackProvider>,
  );
  const markLost = await screen.findByRole('button', { name: 'סמן כאבוד' });
  expect(markLost.classList.contains('small-button')).toBe(true);
  expect(markLost.hasAttribute('data-tone')).toBe(false);
  fireEvent.click(markLost);
  await waitFor(() =>
    expect(radioCommand).toHaveBeenCalledWith('/radios/1/lost', 'POST', { generation: 4 }),
  );
  expect(screen.getByText('אבוד')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'עדכון מיקום' }).hasAttribute('disabled')).toBe(true);
  const markFound = screen.getByRole('button', { name: 'נמצא' });
  expect(markFound.classList.contains('small-button')).toBe(true);
  expect(markFound.hasAttribute('data-tone')).toBe(false);
  fireEvent.click(markFound);
  await waitFor(() =>
    expect(radioCommand).toHaveBeenCalledWith('/radios/1/found', 'POST', { generation: 4 }),
  );
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'עדכון מיקום' }).hasAttribute('disabled')).toBe(
      false,
    ),
  );
  expect(screen.getByText('Alice')).toBeTruthy();
});

it('retries a failed initial load after a toast without leaving a loading message', async () => {
  vi.mocked(fetchRadios).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(fleet);
  const showToast = vi.fn();
  render(
    <DialogStackProvider>
      <Radios active showToast={showToast} />
    </DialogStackProvider>,
  );
  const retry = await screen.findByRole('button', { name: 'ניסיון טעינה מחדש' });
  expect(showToast).toHaveBeenCalledWith('טעינת מכשירי קשר', 'offline', 'error');
  expect(screen.queryByText('טוען מכשירי קשר…')).toBeNull();
  fireEvent.click(retry);
  expect(await screen.findByText('Alice')).toBeTruthy();
  expect(fetchRadios).toHaveBeenCalledTimes(2);
});

it('closes obsolete custody edits on a generation conflict and retains edits on other failures', async () => {
  vi.mocked(fetchRadios).mockResolvedValue(fleet);
  vi.mocked(radioCommand)
    .mockRejectedValueOnce(new Error('temporary failure'))
    .mockRejectedValueOnce(new ApiError(409, 'stale_radio_fleet', 'obsolete'));
  render(
    <DialogStackProvider>
      <Radios active showToast={vi.fn()} />
    </DialogStackProvider>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'עדכון מיקום' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'מחזיק/ה' }), {
    target: { value: 'Edited' },
  });
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'שמירה' }));
  await waitFor(() => expect(radioCommand).toHaveBeenCalledTimes(1));
  expect((screen.getByRole('textbox', { name: 'מחזיק/ה' }) as HTMLInputElement).value).toBe(
    'Edited',
  );
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'שמירה' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(fetchRadios).toHaveBeenCalledTimes(3);
});
