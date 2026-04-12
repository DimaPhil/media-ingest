export class AsyncLimiter {
  private activeCount = 0;

  private readonly queue: Array<() => void> = [];

  public constructor(private readonly concurrency: number) {}

  public async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.activeCount < this.concurrency) {
      this.activeCount += 1;
      return;
    }

    await new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.activeCount += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.activeCount -= 1;
    const next = this.queue.shift();
    next?.();
  }
}

export async function mapConcurrent<TInput, TOutput>(
  values: TInput[],
  concurrency: number,
  mapper: (value: TInput, index: number) => Promise<TOutput>,
): Promise<TOutput[]> {
  if (values.length === 0) {
    return [];
  }

  const items = values.map((value, index) => ({ index, value }));
  const results = new Array<TOutput>(items.length);
  let cursor = 0;

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (cursor < items.length) {
        const item = items[cursor]!;
        cursor += 1;
        results[item.index] = await mapper(item.value, item.index);
      }
    },
  );

  await Promise.all(workers);
  return results;
}
