// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useLostItemRecovery } from '../../src/web/useLostItemRecovery';
import { installWindowStorage } from '../helpers/window-storage';
import type { FrozenOperationAttempt } from '../../src/web/borrower-workflow-recovery';
const api = vi.hoisted(() => ({
  sendFrozenBorrowerAttempt: vi.fn(),
  fetchBorrowerVerification: vi.fn(),
}));
vi.mock('../../src/web/api', () => api);
const attempt: FrozenOperationAttempt = {
  version: 1,
  kind: 'operation',
  endpoint: '/borrowers/7/operations',
  subjectId: 7,
  idempotencyKey: '00000000-0000-4000-8000-000000000001',
  ledgerEpoch: 3,
  stateRevision: 1,
  intent: 'save',
  body: {
    contractVersion: 1,
    ledgerEpoch: 3,
    items: [{ itemId: 11, borrow: [{ quantity: 1, locationId: 1, note: '' }] }],
  },
};
beforeEach(() => {
  installWindowStorage(true);
  vi.resetAllMocks();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const callbacks = () => ({
  onRefresh: vi.fn().mockResolvedValue(undefined),
  onCommitted: vi.fn(),
  onRejected: vi.fn(),
  showToast: vi.fn(),
});
it('does not claim a committed operation was never sent when storing its marker fails', async () => {
  const cb = callbacks();
  const { result } = renderHook(() => useLostItemRecovery(cb));
  await waitFor(() => expect(result.current.startup).toBe(false));
  const write = localStorage.setItem.bind(localStorage);
  vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
    if (JSON.parse(value).verification) throw new Error('marker write failed');
    write(key, value);
  });
  api.sendFrozenBorrowerAttempt.mockResolvedValue({
    kind: 'definitive',
    status: 201,
    result: { outcome: 'committed', idempotencyKey: attempt.idempotencyKey, replayed: false },
  });
  await act(() => result.current.send(attempt));
  expect(api.sendFrozenBorrowerAttempt).toHaveBeenCalledTimes(1);
  expect(cb.showToast).toHaveBeenLastCalledWith(
    'שמירת נתוני השחזור נכשלה',
    expect.any(String),
    'error',
  );
  expect(result.current.attempt?.idempotencyKey).toBe(attempt.idempotencyKey);
  expect(result.current.locked).toBe(true);
});
it('keeps the retirement explanation across failed directory refresh and retry', async () => {
  const cb = callbacks();
  cb.onRefresh.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
  const { result } = renderHook(() => useLostItemRecovery(cb));
  await waitFor(() => expect(result.current.startup).toBe(false));
  api.sendFrozenBorrowerAttempt.mockResolvedValue({
    kind: 'definitive',
    status: 201,
    result: { outcome: 'committed', idempotencyKey: attempt.idempotencyKey, replayed: false },
  });
  api.fetchBorrowerVerification.mockResolvedValue({
    borrowerId: 7,
    ledgerEpoch: 4,
    stateRevision: 0,
    unavailable: true,
  });
  await act(() => result.current.send(attempt));
  expect(result.current.refreshOnly).toBe(true);
  await act(() => result.current.retry());
  expect(cb.showToast).toHaveBeenLastCalledWith('נתוני השואל השתנו', expect.any(String), 'warning');
  expect(result.current.locked).toBe(false);
  expect(api.sendFrozenBorrowerAttempt).toHaveBeenCalledTimes(1);
});
