export class AgentLoopTimeoutError extends Error {
  constructor() {
    super("Agent loop timed out");
  }
}

function msUntilDeadline(deadlineAt: number | undefined): number | undefined {
  if (deadlineAt === undefined) return undefined;
  return deadlineAt - Date.now();
}

export function throwIfDeadlineExpired(deadlineAt: number | undefined): void {
  const remaining = msUntilDeadline(deadlineAt);
  if (remaining !== undefined && remaining <= 0) {
    throw new AgentLoopTimeoutError();
  }
}

export function isDeadlineError(error: unknown, deadlineAt: number | undefined): boolean {
  if (error instanceof AgentLoopTimeoutError) return true;
  const remaining = msUntilDeadline(deadlineAt);
  return remaining !== undefined && remaining <= 0;
}

export function anthropicRequestTimeoutOptions(
  deadlineAt: number | undefined,
): { timeout: number } | undefined {
  const remaining = msUntilDeadline(deadlineAt);
  if (remaining === undefined) return undefined;
  if (remaining <= 0) throw new AgentLoopTimeoutError();
  return { timeout: remaining };
}

export async function awaitWithDeadline<T>(
  promise: Promise<T>,
  deadlineAt: number | undefined,
): Promise<T> {
  const remaining = msUntilDeadline(deadlineAt);
  if (remaining === undefined) return promise;
  if (remaining <= 0) throw new AgentLoopTimeoutError();

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AgentLoopTimeoutError()), remaining);
    timer.unref();
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
