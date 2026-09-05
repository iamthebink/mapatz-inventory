export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  await requireSuccess(response);
  return response.status === 204 ? (undefined as T) : (response.json() as Promise<T>);
}

async function requireSuccess(response: Response): Promise<void> {
  if (!response.ok) {
    const body = await response
      .json()
      .catch(() => ({ error: 'request_failed', message: 'הפעולה נכשלה' }));
    if (response.status === 401 || response.status === 403)
      window.dispatchEvent(new Event('mapatz-auth-stale'));
    throw new ApiError(response.status, body.error, body.message);
  }
}

export async function downloadInventoryWorkbook(): Promise<void> {
  const response = await fetch('/api/workbook');
  await requireSuccess(response);
  const disposition = response.headers.get('content-disposition') ?? '';
  const filename = disposition.match(/filename="?([^";]+)"?/i)?.[1] ?? 'mapatz-inventory.xlsx';
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export async function importResetWorkbook(file: File): Promise<void> {
  const response = await fetch('/api/workbook/reset', {
    method: 'POST',
    headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'x-mapatz-confirmed': 'true',
    },
    body: file,
  });
  await requireSuccess(response);
}

export async function importRecoveryWorkbook(file: File): Promise<void> {
  const response = await fetch('/api/workbook/recovery', {
    method: 'POST',
    headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'x-mapatz-confirmed': 'true',
    },
    body: file,
  });
  await requireSuccess(response);
}
