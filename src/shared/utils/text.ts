/** A scalar as text (strings, numbers, booleans, bigints); anything else becomes `fallback`. */
export function scalarText(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  return fallback;
}
