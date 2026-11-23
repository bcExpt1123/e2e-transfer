const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** Human-readable size using decimal units, as file managers on most platforms do. */
export function formatBytes(bytes: number, locale?: string): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit++;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toLocaleString(locale, { maximumFractionDigits: digits })} ${UNITS[unit]}`;
}
