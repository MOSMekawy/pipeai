/**
 * A counting semaphore for bounding concurrency.
 *
 * `run(fn)` acquires a permit, runs `fn`, and releases the permit afterwards
 * (even if `fn` throws). Constructing with `Infinity` permits makes it an
 * always-open gate (full fan-out — `acquire` never blocks).
 */
export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.available = permits;
  }

  acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      // Hand the permit straight to the next waiter — net permit count is
      // unchanged, so no decrement/increment dance.
      next();
    } else {
      this.available++;
    }
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
