/**
 * Tiered task queue: heavy generative tasks run one at a time (CPU-only box),
 * light tasks may overlap up to a small cap. Reading preferences at run time
 * keeps settings changes live without a restart.
 */
import { readPrefs } from "../routes/misc.js";

type Tier = "heavy" | "light";

const active: Record<Tier, number> = { heavy: 0, light: 0 };
const waiters: Record<Tier, Array<() => void>> = { heavy: [], light: [] };

function limits(): { heavy: number; light: number } {
  const perf = readPrefs().performance ?? {};
  return {
    heavy: Math.max(1, Number(perf.maxHeavyTasks) || 1),
    light: Math.max(1, Number(perf.maxLightTasks) || 2),
  };
}

async function acquire(tier: Tier): Promise<void> {
  if (active[tier] < limits()[tier]) {
    active[tier]++;
    return;
  }
  return new Promise<void>((resolve) => waiters[tier].push(resolve)).then(() => {
    active[tier]++;
  });
}

function release(tier: Tier): void {
  active[tier]--;
  const next = waiters[tier].shift();
  if (next) next();
}

export interface QueueStats {
  activeHeavy: number;
  activeLight: number;
  waitingHeavy: number;
  waitingLight: number;
  limits: { heavy: number; light: number };
}

export function queueStats(): QueueStats {
  return {
    activeHeavy: active.heavy,
    activeLight: active.light,
    waitingHeavy: waiters.heavy.length,
    waitingLight: waiters.light.length,
    limits: limits(),
  };
}

export async function runQueued<T>(tier: Tier, fn: () => Promise<T>): Promise<T> {
  await acquire(tier);
  try {
    return await fn();
  } finally {
    release(tier);
  }
}
