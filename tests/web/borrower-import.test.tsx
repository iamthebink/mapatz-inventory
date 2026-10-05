// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BorrowerImportDialog } from '../../src/web/BorrowerImportDialog';
import { DialogStackProvider } from '../../src/web/Dialog';
import { commitBorrowerImport, previewBorrowerImport } from '../../src/web/api';
vi.mock('../../src/web/api', () => ({
  commitBorrowerImport: vi.fn(),
  previewBorrowerImport: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const preview = {
  confirmationToken: 'a'.repeat(64),
  added: 1,
  updated: 0,
  archived: 1,
  affected: [
    {
      id: 1,
      playaName: 'old-user',
      fullName: 'שואל קודם',
      phoneNumber: '052-123',
      campDepartment: 'Camp South',
      loans: [{ checkoutId: 1, itemId: 1, itemName: 'אוהל', quantity: 3 }],
    },
  ],
  returnLocationId: 1,
  locations: [{ id: 1, name: '\u05DE\u05E4\u05DC\u05E6\u05EA' }],
};
function setup() {
  const onClose = vi.fn();
  const refresh = vi.fn().mockResolvedValue(undefined);
  const showToast = vi.fn();
  render(
    <DialogStackProvider>
      <BorrowerImportDialog
        onClose={onClose}
        refresh={refresh}
        showToast={showToast}
        beforeRequest={async () => {}}
      />
    </DialogStackProvider>,
  );
  fireEvent.change(screen.getByLabelText('קובץ שואלים'), {
    target: { files: [new File(['data'], 'borrowers.xlsx')] },
  });
  fireEvent.change(screen.getByLabelText('אופן הייבוא'), { target: { value: 'replace' } });
  return { onClose, refresh, showToast };
}
describe('borrower import dialog', () => {
  it('shows identities and quantities; keyboard cancel leaves data unchanged', async () => {
    vi.mocked(previewBorrowerImport).mockResolvedValue(preview);
    setup();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'ייבוא' }));
    const confirmation = await screen.findByRole('alertdialog');
    expect(confirmation.textContent).toContain('old-user');
    expect(confirmation.textContent).toContain('052-123');
    expect(confirmation.textContent).toContain('Camp South');
    expect(confirmation.textContent).toContain('אוהל: 3 יחידות');
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(confirmation).getByRole('button', { name: 'ביטול' }),
      ),
    );
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(commitBorrowerImport).not.toHaveBeenCalled();
  });
  it('uses fresh confirmation after state changes and refreshes after successful commit', async () => {
    vi.mocked(previewBorrowerImport).mockResolvedValue(preview);
    const changed = {
      ...preview,
      confirmationToken: 'b'.repeat(64),
      affected: [
        { ...preview.affected[0]!, loans: [{ ...preview.affected[0]!.loans[0]!, quantity: 4 }] },
      ],
      returnLocationId: 1,
      locations: [{ id: 1, name: '\u05DE\u05E4\u05DC\u05E6\u05EA' }],
    };
    vi.mocked(commitBorrowerImport)
      .mockResolvedValueOnce({ outcome: 'confirmation_required', preview: changed })
      .mockResolvedValueOnce({
        outcome: 'committed',
        added: 1,
        updated: 0,
        archived: 1,
        returned: 4,
      });
    const { refresh, showToast, onClose } = setup();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'ייבוא' }));
    await user.click(await screen.findByRole('button', { name: 'אישור החזרה וייבוא' }));
    expect(screen.getByRole('alertdialog').textContent).toContain('אוהל: 4 יחידות');
    expect(showToast).toHaveBeenCalledWith('ייבוא שואלים', expect.any(String), 'warning');
    expect(refresh).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: 'אישור החזרה וייבוא' }));
    expect(vi.mocked(commitBorrowerImport).mock.calls[1]?.[2]).toBe(changed.confirmationToken);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalledOnce();
    expect(showToast).toHaveBeenLastCalledWith('ייבוא שואלים', expect.any(String), 'success');
  });
  it('commits without stock-return dialog when there are no held items and toasts validation errors', async () => {
    vi.mocked(previewBorrowerImport)
      .mockRejectedValueOnce(new Error('Row 4 Name'))
      .mockResolvedValueOnce({ ...preview, affected: [] });
    vi.mocked(commitBorrowerImport).mockResolvedValue({
      outcome: 'committed',
      added: 1,
      updated: 0,
      archived: 1,
      returned: 0,
    });
    const { showToast } = setup();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'ייבוא' }));
    expect(showToast).toHaveBeenCalledWith('ייבוא שואלים', 'Row 4 Name', 'error');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'ייבוא' }));
    expect(commitBorrowerImport).toHaveBeenCalledOnce();
  });
  it('holds the dialog during commit and keeps the same consent on an ambiguous response', async () => {
    vi.mocked(previewBorrowerImport).mockResolvedValue(preview);
    let fail!: (error: Error) => void;
    vi.mocked(commitBorrowerImport).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
    vi.mocked(commitBorrowerImport).mockResolvedValueOnce({
      outcome: 'confirmation_required',
      preview: { ...preview, affected: [] },
    });
    const { showToast, refresh } = setup();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'ייבוא' }));
    await user.click(await screen.findByRole('button', { name: 'אישור החזרה וייבוא' }));
    expect(
      (screen.getByRole('button', { name: 'אישור החזרה וייבוא' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).not.toBeNull();
    fail(new Error('Network response lost'));
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith('ייבוא שואלים', 'Network response lost', 'error'),
    );
    await user.click(screen.getByRole('button', { name: 'אישור החזרה וייבוא' }));
    expect(vi.mocked(commitBorrowerImport).mock.calls.map((call) => call[2])).toEqual([
      preview.confirmationToken,
      preview.confirmationToken,
    ]);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(refresh).toHaveBeenCalledOnce();
  });
});
