export const SEARCH_TITLE_MAX_CHARS = 200;
export const SEARCH_URL_MAX_CHARS = 2048;

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

export interface ReadPage {
  title?: string;
  url: string;
  text: string;
}

/**
 * Parses and normalizes a page (non-empty trimmed text, absolute http(s)
 * resolved URL within the size limit, optional title normalized/capped).
 * Returns undefined for any corrupt or invalid value so cache callers treat
 * it as a cache miss.
 */
export function parseReadPage(value: unknown): ReadPage | undefined {
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
