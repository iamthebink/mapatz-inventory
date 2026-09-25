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
  fireEvent.click(await screen.findByRole('button', { name: 'סמן כאבוד' }));
  await waitFor(() =>
    expect(radioCommand).toHaveBeenCalledWith('/radios/1/lost', 'POST', { generation: 4 }),
  );
  expect(screen.getByText('אבוד')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'עדכון מיקום' }).hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'נמצא' }));
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
