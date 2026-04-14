const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 3;

export class RateLimiter {
  private timestamps = new Map<string, number[]>();

  tryAcquire(userId: string): boolean {
    const now = Date.now();
    const timestamps = this.timestamps.get(userId) ?? [];
    const recent = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
    
    if (recent.length >= RATE_LIMIT_MAX) {
      return false;
    }
    
    recent.push(now);
    this.timestamps.set(userId, recent);
    return true;
  }

  cleanup(): void {
    const now = Date.now();
    for (const [userId, timestamps] of this.timestamps) {
      const recent = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
      if (recent.length === 0) {
        this.timestamps.delete(userId);
      } else {
        this.timestamps.set(userId, recent);
      }
    }
  }
}

export function createRateLimiterCleanup(limiter: RateLimiter): NodeJS.Timeout {
  return setInterval(() => limiter.cleanup(), RATE_LIMIT_WINDOW_MS);
}