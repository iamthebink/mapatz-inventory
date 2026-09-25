// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { RadioFleet } from '../../src/domain/types';
import { DialogStackProvider } from '../../src/web/Dialog';
import { RadioCountSettings } from '../../src/web/RadioCountSettings';
import { fetchRadios, radioCommand } from '../../src/web/api';

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

it('retries an initial count load failure', async () => {
  vi.mocked(fetchRadios).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(fleet);
  const showToast = vi.fn();
  render(
    <DialogStackProvider>
      <RadioCountSettings isAdmin sessionReconciling={false} showToast={showToast} />
    </DialogStackProvider>,
  );
  const retry = await screen.findByRole('button', { name: 'ניסיון טעינה מחדש' });
  expect(showToast).toHaveBeenCalledWith('טעינת מספר מכשירי הקשר', 'offline', 'error');
  fireEvent.click(retry);
  await waitFor(() =>
    expect(screen.getByRole('spinbutton', { name: 'מספר מכשירי קשר' })).toHaveProperty(
      'value',
      '1',
    ),
  );
});

it('keeps the count editor visible but disabled outside admin mode', async () => {
  vi.mocked(fetchRadios).mockResolvedValue(fleet);
  render(
    <DialogStackProvider>
      <RadioCountSettings isAdmin={false} sessionReconciling={false} showToast={vi.fn()} />
    </DialogStackProvider>,
  );
  expect(
    (await screen.findByRole('spinbutton', { name: 'מספר מכשירי קשר' })).hasAttribute('disabled'),
  ).toBe(true);
  expect(screen.getByRole('button', { name: 'שמירה' }).hasAttribute('disabled')).toBe(true);
  expect(screen.getByText('שינוי הכמות דורש מצב מנהל.')).toBeTruthy();
  expect(radioCommand).not.toHaveBeenCalled();
});

it('closes a pending count confirmation and resets the draft when admin mode ends', async () => {
  vi.mocked(fetchRadios).mockResolvedValue(fleet);
  const showToast = vi.fn();
  const view = render(
    <DialogStackProvider>
      <RadioCountSettings isAdmin sessionReconciling={false} showToast={showToast} />
    </DialogStackProvider>,
  );
  fireEvent.change(await screen.findByRole('spinbutton', { name: 'מספר מכשירי קשר' }), {
    target: { value: '2' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'שמירה' }));
  expect(screen.getByRole('alertdialog')).toBeTruthy();
  view.rerender(
    <DialogStackProvider>
      <RadioCountSettings isAdmin={false} sessionReconciling={false} showToast={showToast} />
    </DialogStackProvider>,
  );
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  expect(screen.getByRole('button', { name: 'שמירה' }).hasAttribute('disabled')).toBe(true);
  expect(screen.getByRole('spinbutton', { name: 'מספר מכשירי קשר' })).toHaveProperty('value', '1');
  expect(radioCommand).not.toHaveBeenCalled();
});

it('confirms a count change and displays the returned count', async () => {
  vi.mocked(fetchRadios).mockResolvedValue(fleet);
  vi.mocked(radioCommand).mockResolvedValue({ ...fleet, count: 2, generation: 5 });
  render(
    <DialogStackProvider>
      <RadioCountSettings isAdmin sessionReconciling={false} showToast={vi.fn()} />
    </DialogStackProvider>,
  );
  fireEvent.change(await screen.findByRole('spinbutton', { name: 'מספר מכשירי קשר' }), {
    target: { value: '2' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'שמירה' }));
  const confirmation = screen.getByRole('alertdialog');
  expect(confirmation.textContent).toContain('מ־1 ל־2');
  fireEvent.click(within(confirmation).getByRole('button', { name: 'ביטול' }));
  expect(radioCommand).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'שמירה' }));
  fireEvent.click(
    within(screen.getByRole('alertdialog')).getByRole('button', { name: 'אישור שינוי' }),
  );
  await waitFor(() =>
    expect(radioCommand).toHaveBeenCalledWith('/radios/count', 'PUT', { count: 2, generation: 4 }),
  );
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  expect(screen.getByRole('spinbutton', { name: 'מספר מכשירי קשר' })).toHaveProperty('value', '2');
});

it('disables a pending confirmation during session reconciliation', async () => {
  vi.mocked(fetchRadios).mockResolvedValue(fleet);
  const showToast = vi.fn();
  const view = render(
    <DialogStackProvider>
      <RadioCountSettings isAdmin sessionReconciling={false} showToast={showToast} />
    </DialogStackProvider>,
  );
  fireEvent.change(await screen.findByRole('spinbutton', { name: 'מספר מכשירי קשר' }), {
    target: { value: '2' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'שמירה' }));
  view.rerender(
    <DialogStackProvider>
      <RadioCountSettings isAdmin sessionReconciling showToast={showToast} />
    </DialogStackProvider>,
  );
  expect(
    within(screen.getByRole('alertdialog'))
      .getByRole('button', { name: 'אישור שינוי' })
      .hasAttribute('disabled'),
  ).toBe(true);
  expect(radioCommand).not.toHaveBeenCalled();
});

it('requires a fresh confirmation after a conflicting count save', async () => {
  vi.mocked(fetchRadios)
    .mockResolvedValueOnce(fleet)
    .mockResolvedValueOnce({
      ...fleet,
      generation: 5,
    });
  vi.mocked(radioCommand).mockRejectedValueOnce(new Error('fleet changed'));
  const showToast = vi.fn();
  render(
    <DialogStackProvider>
      <RadioCountSettings isAdmin sessionReconciling={false} showToast={showToast} />
    </DialogStackProvider>,
  );
  fireEvent.change(await screen.findByRole('spinbutton', { name: 'מספר מכשירי קשר' }), {
    target: { value: '2' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'שמירה' }));
  fireEvent.click(
    within(screen.getByRole('alertdialog')).getByRole('button', { name: 'אישור שינוי' }),
  );
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  expect(showToast).toHaveBeenCalledWith('עדכון מספר מכשירי הקשר נכשל', 'fleet changed', 'error');
  fireEvent.change(screen.getByRole('spinbutton', { name: 'מספר מכשירי קשר' }), {
    target: { value: '2' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'שמירה' }));
  expect(screen.getByRole('alertdialog')).toBeTruthy();
  expect(radioCommand).toHaveBeenCalledTimes(1);
});

it('offers a reload after a failed save cannot refresh the fleet', async () => {
  vi.mocked(fetchRadios)
    .mockResolvedValueOnce(fleet)
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce({ ...fleet, generation: 5 });
  vi.mocked(radioCommand).mockRejectedValueOnce(new Error('fleet changed'));
  render(
    <DialogStackProvider>
      <RadioCountSettings isAdmin sessionReconciling={false} showToast={vi.fn()} />
    </DialogStackProvider>,
  );
  fireEvent.change(await screen.findByRole('spinbutton', { name: 'מספר מכשירי קשר' }), {
    target: { value: '2' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'שמירה' }));
  fireEvent.click(
    within(screen.getByRole('alertdialog')).getByRole('button', { name: 'אישור שינוי' }),
  );
  const retry = await screen.findByRole('button', { name: 'ניסיון טעינה מחדש' });
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(screen.getByRole('spinbutton', { name: 'מספר מכשירי קשר' }).hasAttribute('disabled')).toBe(
    true,
  );
  fireEvent.click(retry);
  await waitFor(() =>
    expect(screen.getByRole('spinbutton', { name: 'מספר מכשירי קשר' })).toHaveProperty(
      'value',
      '1',
    ),
  );
  expect(screen.getByRole('button', { name: 'שמירה' }).hasAttribute('disabled')).toBe(false);
});
