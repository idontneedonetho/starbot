import { Semaphore as ShopifySemaphore } from "@shopify/semaphore";
import { RateLimiterMemory } from "rate-limiter-flexible";
import { RATE_LIMIT_WINDOW_SEC, RATE_LIMIT_MAX, MAX_CONCURRENT } from "../config.js";

export const rateLimiter = new RateLimiterMemory({ points: RATE_LIMIT_MAX, duration: RATE_LIMIT_WINDOW_SEC });

// rate-limiter-flexible returns a Promise — must be awaited for the limit to actually fire.
export async function tryAcquireRateLimit(userId: string): Promise<boolean> {
  try {
    await rateLimiter.consume(userId, 1);
    return true;
  } catch {
    return false;
  }
}

export const semaphore = new ShopifySemaphore(MAX_CONCURRENT);

let activeCount = 0;

export function acquireWithQueuePosition(): { release: () => void; position: number; wait: Promise<void> } {
  const position = activeCount;
  activeCount++;
  
  let permitRelease: (() => void) | null = null;
  let isReleased = false;

  const waitPromise = semaphore.acquire().then(permit => {
    if (isReleased) {
      // release() was already called while we were waiting in the queue.
      permit.release();
    } else {
      permitRelease = () => permit.release();
    }
  });

  return {
    release: () => {
      if (isReleased) return;
      isReleased = true;
      activeCount--;
      if (permitRelease) permitRelease();
    },
    position,
    wait: waitPromise,
  };
}