const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  sec: 1_000,
  second: 1_000,
  seconds: 1_000,
  m: 60_000,
  min: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
  w: 604_800_000,
  week: 604_800_000,
  weeks: 604_800_000,
};

/**
 * Parse a human duration to milliseconds. Accepts a number (already ms) or a string like
 * `'500ms'`, `'30s'`, `'15m'`, `'2h'`, `'7d'`, `'7 days'`.
 */
export function parseDuration(duration: string | number): number {
  if (typeof duration === 'number') return duration;
  const match = duration.trim().match(/^(\d+(?:\.\d+)?)\s*([a-z]+)$/i);
  if (!match) throw new Error(`invalid duration: ${duration}`);
  const value = Number(match[1]);
  const unit = (match[2] ?? '').toLowerCase();
  const factor = UNIT_MS[unit];
  if (factor === undefined) throw new Error(`unknown duration unit: ${unit}`);
  return value * factor;
}
