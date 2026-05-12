export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

export function createInactivityTimeout(
  timeoutMs: number,
  message = "timeout",
): { promise: Promise<never>; reset: () => void; clear: () => void } {
  let timer: NodeJS.Timeout;
  let rejectFn!: (err: TimeoutError) => void;

  const promise = new Promise<never>((_, reject) => {
    rejectFn = reject;
    timer = setTimeout(() => reject(new TimeoutError(message)), timeoutMs);
  });

  return {
    promise,
    reset: () => {
      clearTimeout(timer);
      timer = setTimeout(() => rejectFn(new TimeoutError(message)), timeoutMs);
    },
    clear: () => clearTimeout(timer),
  };
}
