export type ProviderErrorHeaders = { get(name: string): string | null };

/**
 * Provider failures are thrown so the loop's recovery classifier keeps seeing
 * `status` and `retry-after`, which pi-ai otherwise encodes only inside the
 * assistant message.
 */
export class ProviderRequestError extends Error {
  readonly status: number | undefined;
  readonly headers: ProviderErrorHeaders | undefined;

  constructor(
    message: string,
    options: { status?: number | undefined; headers?: ProviderErrorHeaders | undefined } = {},
  ) {
    super(message);
    this.name = "ProviderRequestError";
    this.status = options.status;
    this.headers = options.headers;
  }
}

export function headerGetter(
  headers: Record<string, string> | undefined,
): ProviderErrorHeaders | undefined {
  if (headers === undefined) return undefined;
  const lower = new Map(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value] as const),
  );
  return {
    get(name: string): string | null {
      return lower.get(name.toLowerCase()) ?? null;
    },
  };
}

/**
 * pi-ai's HTTP failures surface as `"<status> {json body}"`. Parsing the
 * leading status keeps rate-limit/overload classification working even when
 * the raw response headers were not captured.
 */
export function httpStatusFromMessage(message: string | undefined): number | undefined {
  if (message === undefined) return undefined;
  const match = /^\s*(\d{3})\b/.exec(message);
  if (match?.[1] === undefined) return undefined;
  const status = Number.parseInt(match[1], 10);
  return status >= 400 && status <= 599 ? status : undefined;
}
