// @vitest-environment jsdom
import { createRef } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BorrowerWorkflow, type BorrowerWorkflowHandle } from '../../src/web/BorrowerWorkflow';
import { DialogStackProvider } from '../../src/web/Dialog';

const borrower = {
  id: 7,
  username: 'or',
  name: 'אור',
  contact: '050',
  type: 'individual' as const,
  archived: false,
};
function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('summary card entry', () => {
  it('opens the existing card only after startup recovery and returns after clean close', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    });
    vi.spyOn(history, 'back').mockImplementation(() => {
      window.setTimeout(() => window.dispatchEvent(new PopStateEvent('popstate')), 0);
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const path = String(input);
        if (path.startsWith('/api/borrowers/search'))
          return json({ ledgerEpoch: 3, active: [], archivedMatches: [] });
        if (path === '/api/borrowers/7/desk-snapshot')
          return json({ borrower, inventory: [], holdings: [], stateRevision: 1, ledgerEpoch: 3 });
        throw new Error(path);
      }),
    );
    const ref = createRef<BorrowerWorkflowHandle>();
    const returned = vi.fn();
    const showToast = vi.fn();
    render(
      <DialogStackProvider>
        <BorrowerWorkflow ref={ref} showToast={showToast} deskVisible={false} />
      </DialogStackProvider>,
    );
    ref.current?.openFromSummary(borrower, returned);
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(ref.current).not.toBeNull());
    await waitFor(() => expect(screen.getByText('חיפוש שואל')).toBeTruthy());
    // Recovery completes asynchronously; the next entry opens the real current card.
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith('פתיחת כרטיס שואל', expect.any(String), 'warning'),
    );
    ref.current?.openFromSummary(borrower, returned);
    const dialog = await screen.findByRole('dialog', { name: /כרטיס שואל/ });
    expect(dialog.textContent).toContain('אור');
    await userEvent.click(screen.getAllByRole('button', { name: 'סגירה' })[1]!);
    await waitFor(() => expect(returned).toHaveBeenCalledOnce());
  });
});
