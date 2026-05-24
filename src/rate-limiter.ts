class RateLimiter {
  private capacity: number;
  private tokens: number;
  private queue: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
    signal?: AbortSignal;
    abortHandler?: () => void;
  }> = [];
  private intervalId: ReturnType<typeof setInterval> | null = null;

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
      const entry = this.queue.shift();
      if (entry?.signal && entry.abortHandler) {
        entry.signal.removeEventListener('abort', entry.abortHandler);
      }
      entry?.resolve();
    }
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw createAbortError();
    }
    if (this.capacity === Infinity) {
      return;
    }
    if (this.tokens > 0) {
      this.tokens -= 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const entry = {
        resolve,
        reject,
        signal,
        abortHandler: undefined as (() => void) | undefined,
      };
      if (signal) {
        entry.abortHandler = () => {
          this.queue = this.queue.filter((queued) => queued !== entry);
          reject(createAbortError());
        };
        signal.addEventListener('abort', entry.abortHandler, { once: true });
      }
      this.queue.push(entry);
    });
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
}

function createAbortError(): Error {
  const error = new Error('Operation cancelled');
  error.name = 'AbortError';
  return error;
}

export default RateLimiter;
