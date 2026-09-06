export function formatAdminCountdown(remainingSeconds: number): string {
  const seconds = Math.max(0, Math.min(600, Math.ceil(remainingSeconds)));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
