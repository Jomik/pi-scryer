import { ProviderError, retryAfterMs, type SearchHit, type WebProvider } from "../provider-routing";
import type { ReadPage } from "../web-content";

const ORIGIN = "https://api.tavily.com";
const TIMEOUT_MS = 30_000;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function httpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function request(
  path: "/search" | "/extract",
  payload: unknown,
  key: string | undefined,
  signal?: AbortSignal,
): Promise<unknown> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const cancelled = (): never => {
    if (signal?.aborted) throw new DOMException("Request aborted", "AbortError");
    throw new ProviderError("transient");
  };
  if (combined.aborted) cancelled();

  let response: Response | undefined;
  try {
    response = await fetch(`${ORIGIN}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(key ? { Authorization: `Bearer ${key}` } : { "X-Tavily-Access-Mode": "keyless" }),
      },
      body: JSON.stringify(payload),
      signal: combined,
    });
  } catch {
    cancelled();
  }
  if (combined.aborted) cancelled();
  if (!response) throw new ProviderError("transient");

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    if (combined.aborted) cancelled();
    if (response.ok) throw new ProviderError("transient");
  }
  if (combined.aborted) cancelled();

  if (!response.ok) {
    if (response.status >= 500) throw new ProviderError("transient");
    const error = !key && record(body) && record(body.error) ? body.error : undefined;
    const code = typeof error?.code === "string" ? error.code.toLowerCase() : undefined;
    if (response.status === 402 || (code && /quota|credit|payment/.test(code))) throw new ProviderError("quota");
    if (response.status === 429 || (code && /(^|[_-])(limit|rate|throttl)/.test(code))) {
      const seconds = error?.retry_after_seconds;
      const headerDelay = retryAfterMs(response.headers.get("retry-after"));
      const bodyDelay =
        typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
      throw new ProviderError("rate-limit", headerDelay !== undefined && headerDelay > 0 ? headerDelay : bodyDelay);
    }
    if (key && [401, 403, 432, 433].includes(response.status)) throw new ProviderError("invalid-credentials");
    throw new ProviderError("transient");
  }
  return body;
}

function makeRoute(key?: string) {
  return {
    async search(query: string, signal?: AbortSignal): Promise<SearchHit[]> {
      const body = await request("/search", { query, max_results: 5, include_answer: false }, key, signal);
      if (!record(body) || !Array.isArray(body.results)) throw new ProviderError("transient");
      const hits = body.results.flatMap((entry): SearchHit[] => {
        if (!record(entry) || !httpUrl(entry.url)) return [];
        return [{ url: entry.url.trim(), title: optionalText(entry.title), snippet: optionalText(entry.content) }];
      });
      if (body.results.length && !hits.length) throw new ProviderError("transient");
      return hits;
    },
    async read(url: string, signal?: AbortSignal): Promise<ReadPage> {
      const body = await request("/extract", { urls: [url] }, key, signal);
      const first = record(body) && Array.isArray(body.results) ? body.results[0] : undefined;
      if (!record(first) || !httpUrl(first.url)) throw new ProviderError("transient");
      const text = optionalText(first.raw_content);
      if (!text) throw new ProviderError("transient");
      return { url: first.url.trim(), title: optionalText(first.title), text };
    },
  };
}

export function createTavilyProviders(): WebProvider[] {
  const key = process.env.TAVILY_API_KEY?.trim();
  return [
    ...(key ? [{ name: "tavily", mode: "keyed" as const, ...makeRoute(key) }] : []),
    { name: "tavily-anon", mode: "anonymous", ...makeRoute() },
  ];
}
