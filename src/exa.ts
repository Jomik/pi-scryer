import { resolveExaApiKey } from "./credentials";
import { ProviderError, type ProviderRoute, type SearchHit } from "./provider-routing";

const EXA_CONTENTS_URL = "https://api.exa.ai/contents";
const EXA_SEARCH_URL = "https://api.exa.ai/search";
const REQUEST_TIMEOUT_MS = 30_000;
const SEARCH_TITLE_MAX_CHARS = 200;
const SEARCH_URL_MAX_CHARS = 2048;

class ExaHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

function retryAfterMs(header: string | null): number | undefined {
  if (header === null) return undefined;
  const value = header.trim();
  if (/^\d+$/.test(value)) {
    const delay = Number(value) * 1000;
    return Number.isFinite(delay) ? delay : undefined;
  }
  // Only accept HTTP-date forms, not Date.parse's permissive numeric or informal dates.
  if (
    !/^(?:[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT|[A-Za-z]+, \d{2}-[A-Za-z]{3}-\d{2} \d{2}:\d{2}:\d{2} GMT|[A-Za-z]{3} [A-Za-z]{3} [ \d]\d \d{2}:\d{2}:\d{2} \d{4})$/.test(
      value,
    )
  )
    return undefined;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

export { EXA_SEARCH_URL, SEARCH_TITLE_MAX_CHARS, SEARCH_URL_MAX_CHARS };

export function truncateForDisplay(text: string, maxChars: number): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxChars) {
    return singleLine;
  }
  return `${singleLine.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export interface ExaContentResult {
  title?: string;
  url: string;
  text: string;
}

/**
 * Parses and normalizes a cached JSON value with the same validity rules
 * applied to a fresh Exa result (non-empty trimmed text, absolute http(s)
 * resolved URL within the size limit, optional title normalized/capped).
 * Returns undefined for any corrupt or invalid cache entry so callers treat
 * it as a cache miss.
 */
export function parseCachedExaContentResult(value: unknown): ExaContentResult | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { url, text, title } = value;
  if (!isNonEmptyString(text)) {
    return undefined;
  }
  if (!isNonEmptyString(url) || !isHttpUrl(url.trim())) {
    return undefined;
  }
  const resolvedUrl = url.trim();
  if (resolvedUrl.length > SEARCH_URL_MAX_CHARS) {
    return undefined;
  }
  if (title !== undefined && typeof title !== "string") {
    return undefined;
  }
  return {
    title: isNonEmptyString(title) ? truncateForDisplay(title, SEARCH_TITLE_MAX_CHARS) : undefined,
    url: resolvedUrl,
    text: text.trim(),
  };
}

/**
 * Performs an authenticated POST to an Exa API endpoint, applying the shared
 * timeout/cancellation handling and translating transport, HTTP status, and
 * JSON parsing failures into fixed, key-safe error messages prefixed with the
 * calling tool's name.
 */
export async function callExaApi(
  toolPrefix: string,
  url: string,
  payload: unknown,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const apiKey = await resolveExaApiKey();
  if (!isNonEmptyString(apiKey)) {
    throw new Error(`${toolPrefix}: missing EXA_API_KEY; run /scryer login (macOS) or set EXA_API_KEY`);
  }

  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const composedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: composedSignal,
    });
  } catch {
    if (signal?.aborted) {
      throw new Error(`${toolPrefix}: request cancelled`);
    }
    if (timeoutSignal.aborted) {
      throw new Error(`${toolPrefix}: request timed out`);
    }
    throw new Error(`${toolPrefix}: network request failed`);
  }

  if (!response.ok) {
    if (response.status === 401) {
      throw new ExaHttpError(`${toolPrefix}: invalid API key`, response.status);
    }
    if (response.status === 402) {
      throw new ExaHttpError(`${toolPrefix}: quota exceeded or payment required`, response.status);
    }
    if (response.status === 429) {
      throw new ExaHttpError(
        `${toolPrefix}: rate limited`,
        response.status,
        retryAfterMs(response.headers.get("Retry-After")),
      );
    }
    throw new ExaHttpError(`${toolPrefix}: request failed with status ${response.status}`, response.status);
  }

  try {
    return await response.json();
  } catch {
    if (signal?.aborted) {
      throw new Error(`${toolPrefix}: request cancelled`);
    }
    if (timeoutSignal.aborted) {
      throw new Error(`${toolPrefix}: request timed out`);
    }
    throw new Error(`${toolPrefix}: malformed JSON response from content provider`);
  }
}

/**
 * Fetches and parses a single page's content from Exa for the given
 * normalized URL.
 */
export async function fetchExaContent(
  normalizedUrl: string,
  signal: AbortSignal | undefined,
): Promise<ExaContentResult> {
  const body = await callExaApi("web_read", EXA_CONTENTS_URL, { urls: [normalizedUrl], text: true }, signal);
  return parseFirstResult(body);
}

function routeError(error: unknown, prefix: string, signal?: AbortSignal): never {
  if (signal?.aborted) {
    throw new DOMException("Request aborted", "AbortError");
  }
  if (error instanceof ExaHttpError) {
    if (error.status === 401) throw new ProviderError("invalid-credentials");
    if (error.status === 402) throw new ProviderError("quota");
    if (error.status === 429) throw new ProviderError("rate-limit", error.retryAfterMs);
  }
  if (
    error instanceof Error &&
    error.message === `${prefix}: missing EXA_API_KEY; run /scryer login (macOS) or set EXA_API_KEY`
  ) {
    throw new ProviderError("invalid-credentials");
  }
  throw new ProviderError("transient");
}

/** Exposes the existing authenticated Exa transport only when a key is available. */
export async function createExaKeyedRoute(): Promise<ProviderRoute | undefined> {
  if (!isNonEmptyString(await resolveExaApiKey())) {
    return undefined;
  }
  return {
    async search(query: string, signal?: AbortSignal): Promise<SearchHit[]> {
      try {
        const body = await callExaApi(
          "web_search",
          EXA_SEARCH_URL,
          { query, numResults: 5, contents: { text: { maxCharacters: 500 } } },
          signal,
        );
        if (!isRecord(body) || !Array.isArray(body.results)) {
          throw new ProviderError("transient");
        }
        const hits = body.results.slice(0, 5).flatMap((entry): SearchHit[] => {
          if (!isRecord(entry) || !isNonEmptyString(entry.url)) return [];
          const url = entry.url.trim();
          if (url.length > SEARCH_URL_MAX_CHARS || !isHttpUrl(url)) return [];
          return [
            {
              url,
              title: isNonEmptyString(entry.title)
                ? truncateForDisplay(entry.title, SEARCH_TITLE_MAX_CHARS)
                : undefined,
              snippet: isNonEmptyString(entry.text) ? entry.text.trim().slice(0, 500) : undefined,
            },
          ];
        });
        if (body.results.length > 0 && hits.length === 0) {
          throw new ProviderError("transient");
        }
        if (signal?.aborted) throw new DOMException("Request aborted", "AbortError");
        return hits;
      } catch (error) {
        routeError(error, "web_search", signal);
      }
    },
    async read(url: string, signal?: AbortSignal) {
      try {
        const page = await fetchExaContent(url, signal);
        if (signal?.aborted) throw new DOMException("Request aborted", "AbortError");
        return page;
      } catch (error) {
        routeError(error, "web_read", signal);
      }
    },
  };
}

function parseFirstResult(body: unknown): ExaContentResult {
  if (!isRecord(body)) {
    throw new Error("web_read: malformed response from content provider");
  }
  const statuses = body.statuses;
  if (Array.isArray(statuses)) {
    for (const entry of statuses) {
      if (isRecord(entry) && entry.status === "error") {
        throw new Error("web_read: Exa could not retrieve this URL");
      }
    }
  }

  const results = body.results;
  if (!Array.isArray(results) || results.length === 0) {
    throw new Error("web_read: no content returned for this URL");
  }
  const first = results[0];
  if (!isRecord(first)) {
    throw new Error("web_read: malformed result from content provider");
  }
  const text = first.text;
  const url = first.url;
  const title = first.title;
  if (!isNonEmptyString(text)) {
    throw new Error("web_read: content provider returned empty text");
  }
  if (!isNonEmptyString(url) || !isHttpUrl(url.trim())) {
    throw new Error("web_read: content provider returned an invalid result URL");
  }
  const resolvedUrl = url.trim();
  if (resolvedUrl.length > SEARCH_URL_MAX_CHARS) {
    throw new Error("web_read: content provider returned an oversized result URL");
  }
  return {
    title: isNonEmptyString(title) ? truncateForDisplay(title, SEARCH_TITLE_MAX_CHARS) : undefined,
    url: resolvedUrl,
    text: text.trim(),
  };
}
