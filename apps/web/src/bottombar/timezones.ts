export const TIMEZONES: { id: string; label: string }[] = [
  { id: 'exchange', label: 'Exchange' },
  { id: 'local', label: 'Local' },
  { id: 'UTC', label: 'UTC' },
  { id: 'America/New_York', label: 'New York' },
  { id: 'America/Chicago', label: 'Chicago' },
  { id: 'America/Denver', label: 'Denver' },
  { id: 'America/Los_Angeles', label: 'Los Angeles' },
  { id: 'America/Toronto', label: 'Toronto' },
  { id: 'America/Sao_Paulo', label: 'São Paulo' },
  { id: 'Europe/London', label: 'London' },
  { id: 'Europe/Berlin', label: 'Berlin' },
  { id: 'Europe/Paris', label: 'Paris' },
  { id: 'Europe/Zurich', label: 'Zurich' },
  { id: 'Europe/Istanbul', label: 'Istanbul' },
  { id: 'Europe/Moscow', label: 'Moscow' },
  { id: 'Asia/Dubai', label: 'Dubai' },
  { id: 'Asia/Kolkata', label: 'Kolkata' },
  { id: 'Asia/Singapore', label: 'Singapore' },
  { id: 'Asia/Hong_Kong', label: 'Hong Kong' },
  { id: 'Asia/Shanghai', label: 'Shanghai' },
  { id: 'Asia/Tokyo', label: 'Tokyo' },
  { id: 'Australia/Sydney', label: 'Sydney' },
];

/** Resolve the app timezone option to an IANA zone (or undefined = browser local). */
export function resolveTimezone(
  opt: string,
  exchangeTz: string | null | undefined,
): string | undefined {
  if (opt === 'exchange') return exchangeTz ?? 'UTC';
  if (opt === 'local') return undefined;
  return opt;
}

/** "UTC-4", "UTC+5:30" */
export function utcOffsetLabel(tz: string | undefined, date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    timeZoneName: 'shortOffset',
  }).formatToParts(date);
  const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  return name.replace('GMT', 'UTC').replace(/^UTC$/, 'UTC');
}
