/**
 * A counting semaphore for bounding concurrency. `acquire()` resolves when a
 * permit is available; `release()` hands the permit to the next waiter (or
 * returns it to the pool). Constructing with `Infinity` permits makes it an
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
}
