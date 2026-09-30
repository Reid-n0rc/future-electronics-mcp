// Server-wide request limiter for the Future Electronics API.
//
// The Future docs publish no numeric rate limit; they only document
// `429 Too Many Requests. Please wait and try again`. This limiter caps how
// many requests are in flight at once, can optionally space request starts
// apart, and supports a global cooldown after a 429 so every caller backs off.
//
// Deadlock safety: a slot is only ever held between `acquire()` resolving and
// its release function being called. `run()` releases in `finally`, release
// functions are idempotent, and a failure while waiting to start frees the
// slot before rethrowing.

import { ConfigError } from "./config.js";

export interface RateLimiterOptions {
  /** Most requests allowed in flight at once. Default 4. */
  maxConcurrency?: number;
  /** Minimum gap between request starts, in ms. Default 0 (no pacing). */
  minIntervalMs?: number;
  /** Clock in ms. Default `Date.now`. */
  now?: () => number;
  /** Waits `ms` milliseconds. Default uses `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_MAX_CONCURRENCY = 4;
export const DEFAULT_MIN_INTERVAL_MS = 0;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class RateLimiter {
  readonly maxConcurrency: number;
  readonly minIntervalMs: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  #active = 0;
  readonly #waiting: Array<() => void> = [];
  /** Start gate: serializes the cooldown/pacing check so starts stay FIFO. */
  #gate: Promise<void> = Promise.resolve();
  #lastStart = Number.NEGATIVE_INFINITY;
  #pausedUntil = Number.NEGATIVE_INFINITY;

  constructor(options: RateLimiterOptions = {}) {
    const maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
      throw new ConfigError("maxConcurrency must be a positive integer.");
    }
    const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    if (!Number.isFinite(minIntervalMs) || minIntervalMs < 0) {
      throw new ConfigError("minIntervalMs must be a non-negative number.");
    }
    this.maxConcurrency = maxConcurrency;
    this.minIntervalMs = minIntervalMs;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? defaultSleep;
  }

  /** Requests currently holding a slot. */
  get inFlight(): number {
    return this.#active;
  }

  /** Callers queued for a slot. */
  get queued(): number {
    return this.#waiting.length;
  }

  /** Time (from `now()`) before which no new request starts. */
  get pausedUntil(): number {
    return this.#pausedUntil;
  }

  /**
   * Blocks new request starts until `timestamp`, server-wide. Requests already
   * in flight are not affected. A shorter pause never cuts a longer one short.
   */
  pauseUntil(timestamp: number): void {
    if (Number.isFinite(timestamp) && timestamp > this.#pausedUntil) {
      this.#pausedUntil = timestamp;
    }
  }

  /**
   * Waits for a free slot (FIFO), then for any cooldown or pacing interval,
   * and returns a release function. `notBefore` tells the limiter that the
   * caller has already waited until that time on its own clock, so it is not
   * made to wait for the same cooldown twice.
   */
  async acquire(notBefore = Number.NEGATIVE_INFINITY): Promise<() => void> {
    if (this.#active < this.maxConcurrency && this.#waiting.length === 0) {
      this.#active++;
    } else {
      // The releasing caller hands its slot over, so #active is unchanged.
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
    }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.#releaseSlot();
    };
    try {
      await this.#waitToStart(notBefore);
    } catch (error) {
      release();
      throw error;
    }
    return release;
  }

  /** Runs `task` while holding a slot. The slot is always released. */
  async run<T>(task: () => Promise<T>, notBefore?: number): Promise<T> {
    const release = await this.acquire(notBefore);
    try {
      return await task();
    } finally {
      release();
    }
  }

  #releaseSlot(): void {
    const next = this.#waiting.shift();
    if (next) next();
    else this.#active--;
  }

  #waitToStart(notBefore: number): Promise<void> {
    const turn = this.#gate.then(() => this.#openGate(notBefore));
    this.#gate = turn.catch(() => {});
    return turn;
  }

  async #openGate(notBefore: number): Promise<void> {
    // `floor` records how far we know time has advanced, so an injected sleep
    // that does not move the clock still ends the wait.
    let floor = notBefore;
    for (;;) {
      const now = Math.max(this.#now(), floor);
      const ready = Math.max(this.#pausedUntil, this.#lastStart + this.minIntervalMs);
      if (now >= ready) {
        this.#lastStart = now;
        return;
      }
      await this.#sleep(ready - now);
      floor = ready;
    }
  }
}
