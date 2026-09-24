import { DomainError } from './types.js';

const israelDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Jerusalem',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const israelDateTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Jerusalem',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function parts(formatter: Intl.DateTimeFormat, date: Date): Record<string, number> {
  return Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  );
}

export function todayInIsrael(now = new Date()): string {
  const date = parts(israelDate, now);
  return `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}

function calendarDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new DomainError('invalid_period', 'יש לבחור תאריך תקין');
  const [year, month, day] = value.split('-').map(Number);
  if (year === 0) throw new DomainError('invalid_period', 'יש לבחור תאריך תקין');
  const date = new Date(0);
  date.setUTCFullYear(year!, month! - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  if (date.toISOString().slice(0, 10) !== value)
    throw new DomainError('invalid_period', 'יש לבחור תאריך תקין');
  return date;
}

function localMidnightUtc(value: string): Date {
  const target = calendarDate(value).getTime();
  let instant = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const local = parts(israelDateTime, new Date(instant));
    const representedDate = new Date(0);
    representedDate.setUTCFullYear(local.year!, local.month! - 1, local.day!);
    representedDate.setUTCHours(local.hour!, local.minute!, local.second!, 0);
    const represented = representedDate.getTime();
    instant += target - represented;
  }
  return new Date(instant);
}

function sqliteUtc(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

export function periodBounds(start: string, end: string, now = new Date()) {
  const endDate = calendarDate(end);
  calendarDate(start);
  if (start > end || end > todayInIsrael(now))
    throw new DomainError('invalid_period', 'טווח התאריכים אינו תקין');
  const nextDay = new Date(endDate.getTime() + 86_400_000).toISOString().slice(0, 10);
  return {
    startUtc: sqliteUtc(localMidnightUtc(start)),
    endExclusiveUtc: sqliteUtc(localMidnightUtc(nextDay)),
  };
}
