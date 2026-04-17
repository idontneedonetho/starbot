import { Semaphore as ShopifySemaphore } from "@shopify/semaphore";
import { RateLimiterMemory } from "rate-limiter-flexible";

const RATE_LIMIT_WINDOW_SEC = 60;
const RATE_LIMIT_MAX = 3;
const MAX_CONCURRENT = 2;

export const rateLimiter = new RateLimiterMemory({ points: RATE_LIMIT_MAX, duration: RATE_LIMIT_WINDOW_SEC });

export function tryAcquireRateLimit(userId: string): boolean {
  try {
    rateLimiter.consume(userId, 1);
    return true;
  } catch {
    return false;
  }
}

export const semaphore = new ShopifySemaphore(MAX_CONCURRENT);

let activeCount = 0;

export async function acquireWithQueuePosition(): Promise<{ release: () => void; position: number }> {
  const position = activeCount;
  const permit = await semaphore.acquire();
  activeCount++;
  return {
    release: () => {
      activeCount--;
      permit.release();
    },
    position
  };
}

export function getQueuePosition(): number {
  return activeCount;
}