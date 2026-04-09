import { createHash } from 'node:crypto';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stableSort(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableSort);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.keys(value)
    .sort()
    .reduce<Record<string, unknown>>((accumulator, key) => {
      accumulator[key] = stableSort(value[key]);
      return accumulator;
    }, {});
}

export function createFingerprint(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(stableSort(value)))
    .digest('hex');
}
