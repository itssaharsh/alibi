/** Stops a timer. */
export type Cancel = () => void;

/**
 * The only way the service learns the time or waits. The real clock is built in `main.ts`;
 * tests pass one they can move by hand.
 */
export interface Clock {
  now(): number;
  after(ms: number, run: () => void): Cancel;
  every(ms: number, run: () => void): Cancel;
}

export function systemClock(): Clock {
  return {
    now: () => Date.now(),
    after(ms, run) {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    },
    every(ms, run) {
      const timer = setInterval(run, ms);
      return () => clearInterval(timer);
    },
  };
}

export function sleep(clock: Clock, ms: number): Promise<void> {
  return new Promise((resolve) => {
    clock.after(ms, resolve);
  });
}

/** Counts calls and file writes that are still under way, so tests can wait until the service is quiet. */
export class Tracker {
  private inflight = 0;

  async track<T>(work: Promise<T>): Promise<T> {
    this.inflight += 1;
    try {
      return await work;
    } finally {
      this.inflight -= 1;
    }
  }

  /** Resolves once nothing has been under way for two turns of the event loop. */
  async idle(): Promise<void> {
    for (let quiet = 0; quiet < 2; ) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      quiet = this.inflight === 0 ? quiet + 1 : 0;
    }
  }
}
