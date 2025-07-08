class RateLimiter {
  private capacity: number;
  private tokens: number;
  private queue: Array<() => void> = [];
  private intervalId: NodeJS.Timer | null = null;

  constructor(rps: number) {
    if (!rps || rps <= 0 || !Number.isFinite(rps)) {
      this.capacity = Infinity;
      this.tokens = Infinity;
      return;
    }
    this.capacity = rps;
    this.tokens = rps;
    this.intervalId = setInterval(() => {
      this.tokens = this.capacity;
      this.processQueue();
    }, 1000);
  }

  private processQueue() {
    while (this.tokens > 0 && this.queue.length > 0) {
      this.tokens -= 1;
      const resolve = this.queue.shift();
      resolve?.();
    }
  }

  async acquire(): Promise<void> {
    if (this.capacity === Infinity) {
      return;
    }
    if (this.tokens > 0) {
      this.tokens -= 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }
}

export default RateLimiter;
