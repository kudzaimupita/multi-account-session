import type { Clock } from '../src/index.ts';

export interface FakeClock {
  readonly now: Clock;
  advance(ms: number): void;
  set(ms: number): void;
}

/** A clock that only moves when told to. */
export function fakeClock(start = 1_700_000_000_000): FakeClock {
  let current = start;
  return {
    now: () => current,
    advance(ms) {
      current += ms;
    },
    set(ms) {
      current = ms;
    },
  };
}

/** Deterministic 32-byte key for tests: every byte is `fill`. */
export function testKey(fill: number): Buffer {
  return Buffer.alloc(32, fill);
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
