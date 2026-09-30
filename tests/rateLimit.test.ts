import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigError } from "../src/config.js";
import {
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_MIN_INTERVAL_MS,
  RateLimiter,
  type RateLimiterOptions,
} from "../src/rateLimit.js";

/** A manual clock: `sleep` resolves only when `advance` passes its deadline. */
class FakeClock {
  time = 1_000_000;
  sleeps: number[] = [];
  #timers: Array<{ at: number; resolve: () => void }> = [];

  now = () => this.time;

  sleep = (ms: number) => {
    this.sleeps.push(ms);
    return new Promise<void>((resolve) => this.#timers.push({ at: this.time + ms, resolve }));
  };

  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    for (;;) {
      await flush();
      const due = this.#timers
        .filter((t) => t.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.time = Math.max(this.time, due.at);
      this.#timers.splice(this.#timers.indexOf(due), 1);
      due.resolve();
    }
    this.time = target;
    await flush();
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function make(options: RateLimiterOptions = {}) {
  const clock = new FakeClock();
  const limiter = new RateLimiter({ now: clock.now, sleep: clock.sleep, ...options });
  return { clock, limiter };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("RateLimiter constructor", () => {
  it("defaults to 4 in flight and no pacing", () => {
    const limiter = new RateLimiter();
    expect(DEFAULT_MAX_CONCURRENCY).toBe(4);
    expect(DEFAULT_MIN_INTERVAL_MS).toBe(0);
    expect(limiter.maxConcurrency).toBe(4);
    expect(limiter.minIntervalMs).toBe(0);
    expect(limiter.inFlight).toBe(0);
    expect(limiter.queued).toBe(0);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects maxConcurrency %s",
    (maxConcurrency) => {
      expect(() => new RateLimiter({ maxConcurrency })).toThrow(ConfigError);
      expect(() => new RateLimiter({ maxConcurrency })).toThrow(/maxConcurrency/);
    },
  );

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])("rejects minIntervalMs %s", (minIntervalMs) => {
    expect(() => new RateLimiter({ minIntervalMs })).toThrow(ConfigError);
    expect(() => new RateLimiter({ minIntervalMs })).toThrow(/minIntervalMs/);
  });

  it("uses a real setTimeout sleep and Date.now by default", async () => {
    vi.useFakeTimers({ now: 0 });
    const limiter = new RateLimiter({ minIntervalMs: 100 });
    await limiter.run(async () => {});
    let started = false;
    const second = limiter.run(async () => {
      started = true;
    });
    await vi.advanceTimersByTimeAsync(99);
    expect(started).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await second;
    expect(started).toBe(true);
  });
});

describe("concurrency cap", () => {
  it.each([1, 2, 4])("never exceeds %i in flight with more callers than slots", async (n) => {
    const { limiter } = make({ maxConcurrency: n });
    let active = 0;
    let peak = 0;
    const gates = Array.from({ length: n * 3 }, () => deferred());
    const runs = gates.map((gate) =>
      limiter.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await gate.promise;
        active--;
      }),
    );
    await flush();
    expect(active).toBe(n);
    expect(limiter.inFlight).toBe(n);
    expect(limiter.queued).toBe(n * 2);
    for (const gate of gates) {
      gate.resolve();
      await flush();
      expect(active).toBeLessThanOrEqual(n);
    }
    await Promise.all(runs);
    expect(peak).toBe(n);
    expect(limiter.inFlight).toBe(0);
    expect(limiter.queued).toBe(0);
  });

  it("serves waiting callers in FIFO order", async () => {
    const { limiter } = make({ maxConcurrency: 1 });
    const order: number[] = [];
    const first = deferred();
    const runs = [limiter.run(() => first.promise)];
    for (let i = 1; i <= 5; i++) {
      runs.push(
        limiter.run(async () => {
          order.push(i);
        }),
      );
    }
    await flush();
    expect(order).toEqual([]);
    first.resolve();
    await Promise.all(runs);
    expect(order).toEqual([1, 2, 3, 4, 5]);
  });

  it("frees slots when tasks fail (timeouts, network and schema errors)", async () => {
    const { limiter } = make({ maxConcurrency: 2 });
    const failures = [
      new Error("Timed out"),
      new TypeError("fetch failed"),
      new Error("Unexpected response shape"),
      new Error("sync throw"),
    ];
    const results = await Promise.allSettled(
      failures.map((error, i) =>
        limiter.run(() => {
          if (i === 3) throw error;
          return Promise.reject(error);
        }),
      ),
    );
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(results.map((r) => (r as PromiseRejectedResult).reason)).toEqual(failures);
    expect(limiter.inFlight).toBe(0);
    expect(limiter.queued).toBe(0);
    // Both slots are usable again.
    const gates = [deferred(), deferred()];
    const runs = gates.map((g) => limiter.run(() => g.promise));
    await flush();
    expect(limiter.inFlight).toBe(2);
    gates.forEach((g) => g.resolve());
    await Promise.all(runs);
    expect(limiter.inFlight).toBe(0);
  });

  it("release functions from acquire are idempotent", async () => {
    const { limiter } = make({ maxConcurrency: 1 });
    const release = await limiter.acquire();
    expect(limiter.inFlight).toBe(1);
    release();
    release();
    expect(limiter.inFlight).toBe(0);
    const again = await limiter.acquire();
    const pending = limiter.acquire();
    await flush();
    expect(limiter.queued).toBe(1);
    again();
    again();
    (await pending)();
    expect(limiter.inFlight).toBe(0);
  });

  it("frees the slot if waiting to start fails", async () => {
    const sleep = vi.fn().mockRejectedValueOnce(new Error("sleep failed"));
    const limiter = new RateLimiter({ maxConcurrency: 1, now: () => 0, sleep });
    limiter.pauseUntil(10);
    await expect(limiter.run(async () => "never")).rejects.toThrow("sleep failed");
    expect(limiter.inFlight).toBe(0);
    // The start gate is not poisoned by the failure.
    sleep.mockResolvedValue(undefined);
    await expect(limiter.run(async () => "ok")).resolves.toBe("ok");
  });
});

describe("pacing", () => {
  it("adds no delay with the default interval of 0", async () => {
    const { clock, limiter } = make({ maxConcurrency: 4 });
    const starts: number[] = [];
    await Promise.all(
      Array.from({ length: 8 }, () =>
        limiter.run(async () => {
          starts.push(clock.time);
        }),
      ),
    );
    expect(clock.sleeps).toEqual([]);
    expect(new Set(starts).size).toBe(1);
  });

  it("starts a single call immediately", async () => {
    const { clock, limiter } = make();
    await expect(limiter.run(async () => 42)).resolves.toBe(42);
    expect(clock.sleeps).toEqual([]);
  });

  it("spaces request starts at least the interval apart", async () => {
    const { clock, limiter } = make({ maxConcurrency: 4, minIntervalMs: 250 });
    const starts: number[] = [];
    const runs = Array.from({ length: 4 }, () =>
      limiter.run(async () => {
        starts.push(clock.time);
      }),
    );
    await clock.advance(1000);
    await Promise.all(runs);
    expect(starts).toHaveLength(4);
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(250);
    }
    expect(starts[0]).toBe(1_000_000);
  });

  it("does not delay a request that comes after the interval has passed", async () => {
    const { clock, limiter } = make({ minIntervalMs: 250 });
    await limiter.run(async () => {});
    await clock.advance(300);
    await limiter.run(async () => {});
    expect(clock.sleeps).toEqual([]);
  });
});

describe("global cooldown", () => {
  it("blocks new starts until the pause ends, without cancelling in-flight requests", async () => {
    const { clock, limiter } = make({ maxConcurrency: 4 });
    const inFlight = deferred<string>();
    const running = limiter.run(() => inFlight.promise);
    await flush();
    limiter.pauseUntil(clock.time + 2000);
    expect(limiter.pausedUntil).toBe(clock.time + 2000);

    let started = 0;
    const waiting = Array.from({ length: 3 }, () =>
      limiter.run(async () => {
        started++;
      }),
    );
    await clock.advance(1999);
    expect(started).toBe(0);
    inFlight.resolve("done");
    await expect(running).resolves.toBe("done");
    await clock.advance(1);
    await Promise.all(waiting);
    expect(started).toBe(3);
  });

  it("never shortens a longer pause, and ignores non-finite values", () => {
    const { limiter } = make();
    limiter.pauseUntil(5000);
    limiter.pauseUntil(1000);
    limiter.pauseUntil(Number.NaN);
    limiter.pauseUntil(Number.POSITIVE_INFINITY);
    expect(limiter.pausedUntil).toBe(5000);
  });

  it("extends the wait if the pause grows while a caller sleeps", async () => {
    const { clock, limiter } = make();
    limiter.pauseUntil(clock.time + 1000);
    let started = false;
    const run = limiter.run(async () => {
      started = true;
    });
    await clock.advance(500);
    limiter.pauseUntil(clock.time + 1000);
    await clock.advance(999);
    expect(started).toBe(false);
    await clock.advance(1);
    await run;
    expect(started).toBe(true);
  });

  it("skips a wait the caller already served (notBefore)", async () => {
    const { clock, limiter } = make();
    const until = clock.time + 1000;
    limiter.pauseUntil(until);
    await limiter.run(async () => {}, until);
    expect(clock.sleeps).toEqual([]);
  });

  it("terminates with an injected sleep that does not move the clock", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const limiter = new RateLimiter({ now: () => 0, sleep, minIntervalMs: 100 });
    limiter.pauseUntil(500);
    await limiter.run(async () => {});
    await limiter.run(async () => {});
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([500, 600]);
  });
});
