import { describe, expect, it } from 'vitest';

import { AsyncLimiter, mapConcurrent } from '../src/async';

describe('AsyncLimiter', () => {
  it('caps concurrent tasks', async () => {
    const limiter = new AsyncLimiter(2);
    let active = 0;
    let maxActive = 0;

    await Promise.all(
      Array.from({ length: 6 }, async (_, index) =>
        limiter.run(async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 15 + index));
          active -= 1;
          return index;
        })),
    );

    expect(maxActive).toBe(2);
  });
});

describe('mapConcurrent', () => {
  it('returns an empty array when there is no work', async () => {
    const result = await mapConcurrent([], 2, async (value: number) => value + 1);
    expect(result).toEqual([]);
  });

  it('preserves input order while running work concurrently', async () => {
    const values = [0, 1, 2, 3];
    const result = await mapConcurrent(values, 2, async (value) => {
      await new Promise((resolve) => setTimeout(resolve, 20 - value * 3));
      return `value-${value}`;
    });

    expect(result).toEqual(['value-0', 'value-1', 'value-2', 'value-3']);
  });
});
