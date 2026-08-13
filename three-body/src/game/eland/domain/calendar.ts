export const MONTHS_PER_YEAR = 12 as const;

export interface CalendarDate {
  elapsedMonths: number;
  year: number;
  month: number;
  label: string;
}

export function calendarDate(elapsedMonths: number): CalendarDate {
  const safe = Math.max(0, Math.floor(elapsedMonths));
  const year = safe === 0 ? 1 : Math.floor((safe - 1) / MONTHS_PER_YEAR) + 1;
  const month = safe === 0 ? 1 : (safe - 1) % MONTHS_PER_YEAR + 1;
  return { elapsedMonths: safe, year, month, label: `第 ${year} 年 · ${month} 月` };
}

export function isYearBoundary(elapsedMonths: number): boolean {
  return elapsedMonths > 0 && elapsedMonths % MONTHS_PER_YEAR === 0;
}
