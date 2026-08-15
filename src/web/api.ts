export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: 'request_failed', message: 'הפעולה נכשלה' }));
    if (response.status === 401 || response.status === 403) window.dispatchEvent(new Event('mapatz-auth-stale'));
    throw new ApiError(response.status, body.error, body.message);
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}
