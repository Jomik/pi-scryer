import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type ExtensionAPI,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Text, TruncatedText } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const CACHE_DIR_PREFIX = "pi-scryer-";
const CACHE_MAX_ENTRIES = 5;

const EXA_CONTENTS_URL = "https://api.exa.ai/contents";
const EXA_SEARCH_URL = "https://api.exa.ai/search";
const REQUEST_TIMEOUT_MS = 30_000;
const SEARCH_MAX_RESULTS = 5;
const SEARCH_EXCERPT_MAX_CHARS = 500;
const SEARCH_TITLE_MAX_CHARS = 200;
const SEARCH_URL_MAX_CHARS = 2048;
const CALL_PREVIEW_MAX_CHARS = 80;
const DISPLAY_LINE_MAX_CHARS = 80;
// Fixed byte/line allowance reserved for the continuation marker appended to
// non-final web_read chunks, so the assembled output (header + content +
// marker) never exceeds DEFAULT_MAX_BYTES/DEFAULT_MAX_LINES.
const OFFSET_MARKER_RESERVE_BYTES = 320;
const OFFSET_MARKER_RESERVE_LINES = 4;

interface WebReadToolDetails {
  title?: string;
  source: string;
  truncated: boolean;
  offset: number;
  nextOffset?: number;
  totalLength: number;
}

interface WebSearchToolDetails {
  resultCount: number;
  omitted: number;
  truncated: boolean;
}

function truncateForDisplay(text: string, maxChars: number): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxChars) {
    return singleLine;
  }
  return `${singleLine.slice(0, Math.max(0, maxChars - 1))}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

interface ExaContentResult {
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
function parseCachedExaContentResult(value: unknown): ExaContentResult | undefined {
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

interface ExaSearchResult {
  title?: string;
  url: string;
  text?: string;
}

/**
 * Performs an authenticated POST to an Exa API endpoint, applying the shared
 * timeout/cancellation handling and translating transport, HTTP status, and
 * JSON parsing failures into fixed, key-safe error messages prefixed with the
 * calling tool's name.
 */
async function callExaApi(
  toolPrefix: string,
  url: string,
  payload: unknown,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const apiKey = process.env.EXA_API_KEY?.trim();
  if (!isNonEmptyString(apiKey)) {
    throw new Error(`${toolPrefix}: missing EXA_API_KEY`);
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
      throw new Error(`${toolPrefix}: invalid API key`);
    }
    if (response.status === 402) {
      throw new Error(`${toolPrefix}: quota exceeded or payment required`);
    }
    if (response.status === 429) {
      throw new Error(`${toolPrefix}: rate limited`);
    }
    throw new Error(`${toolPrefix}: request failed with status ${response.status}`);
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

function parseSearchResults(body: unknown): { results: ExaSearchResult[]; omitted: number } {
  if (!isRecord(body)) {
    throw new Error("web_search: malformed response from search provider");
  }
  const results = body.results;
  if (!Array.isArray(results)) {
    throw new Error("web_search: malformed response from search provider");
  }
  if (results.length === 0) {
    return { results: [], omitted: 0 };
  }

  const candidates = results.slice(0, SEARCH_MAX_RESULTS);
  const valid: ExaSearchResult[] = [];
  let omitted = 0;

  for (const entry of candidates) {
    if (!isRecord(entry)) {
      omitted += 1;
      continue;
    }
    const rawUrl = entry.url;
    if (!isNonEmptyString(rawUrl)) {
      omitted += 1;
      continue;
    }
    const url = rawUrl.trim();
    if (url.length > SEARCH_URL_MAX_CHARS || !isHttpUrl(url)) {
      omitted += 1;
      continue;
    }
    const rawTitle = entry.title;
    const title = isNonEmptyString(rawTitle) ? truncateForDisplay(rawTitle, SEARCH_TITLE_MAX_CHARS) : undefined;
    const rawText = entry.text;
    const text = isNonEmptyString(rawText) ? rawText.trim().slice(0, SEARCH_EXCERPT_MAX_CHARS) : undefined;
    valid.push({ title, url, text });
  }

  if (valid.length === 0) {
    throw new Error("web_search: malformed results from search provider");
  }

  return { results: valid, omitted };
}

function buildSearchMarkdown(results: ExaSearchResult[], omitted: number): string {
  if (results.length === 0) {
    return "No search results found.";
  }

  const lines: string[] = [];
  results.forEach((result, index) => {
    if (result.title) {
      lines.push(`${index + 1}. ${result.title}`);
      lines.push(`Source: ${result.url}`);
    } else {
      lines.push(`${index + 1}. Source: ${result.url}`);
    }
    if (result.text) {
      lines.push(result.text);
    }
    lines.push("");
  });

  if (omitted > 0) {
    lines.push(`(${omitted} result${omitted === 1 ? "" : "s"} omitted due to malformed data)`);
  }

  return lines.join("\n").trimEnd();
}

/**
 * Builds the continuation marker appended to a non-final web_read chunk.
 * States the current offset, the exact next offset to pass back in, and the
 * total extracted text length, without repeating the source URL.
 */
function buildOffsetMarker(offset: number, nextOffset: number, totalLength: number): string {
  return `\n\n[Showing offsets ${offset}-${nextOffset - 1} of ${totalLength}. Continue with web_read(url, offset: ${nextOffset})]`;
}

/**
 * Takes the largest prefix of `text` whose UTF-8 byte size fits within
 * `maxBytes`, walking whole Unicode code points (never splitting a surrogate
 * pair). Used only for the rare case where a single line exceeds the byte
 * budget and truncateHead cannot return any content for it.
 */
function takeUtf8BytePrefix(text: string, maxBytes: number): string {
  let usedBytes = 0;
  let result = "";
  for (const codePoint of text) {
    const codePointBytes = Buffer.byteLength(codePoint, "utf-8");
    if (usedBytes + codePointBytes > maxBytes) {
      break;
    }
    result += codePoint;
    usedBytes += codePointBytes;
  }
  return result;
}

/**
 * Fetches and parses a single page's content from Exa for the given
 * normalized URL.
 */
async function fetchExaContent(normalizedUrl: string, signal: AbortSignal | undefined): Promise<ExaContentResult> {
  const body = await callExaApi("web_read", EXA_CONTENTS_URL, { urls: [normalizedUrl], text: true }, signal);
  return parseFirstResult(body);
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

export default function activate(api: ExtensionAPI): void {
  // Per-process disk cache for web_read continuations. Bounded to
  // CACHE_MAX_ENTRIES pages, each backed by a private temp-directory file
  // keyed by a SHA-256 hash of the normalized URL (never the raw URL). Only
  // file path/order metadata is retained in memory between execute calls; no
  // full Exa text is kept resident. All read/write/evict/cleanup operations
  // are serialized through a small promise queue so cleanup and eviction
  // never race an in-flight file operation; network fetches stay outside it.
  let cacheDir: string | undefined;
  let cacheDirPromise: Promise<string> | undefined;
  const cacheEntries = new Map<string, { file: string }>();
  let cacheQueue: Promise<void> = Promise.resolve();

  function enqueueCacheTask<T>(task: () => Promise<T>): Promise<T> {
    const run = cacheQueue.then(task, task);
    cacheQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function ensureCacheDir(): Promise<string> {
    if (cacheDir) {
      return cacheDir;
    }
    if (!cacheDirPromise) {
      cacheDirPromise = (async () => {
        let dir: string | undefined;
        try {
          dir = await mkdtemp(join(tmpdir(), CACHE_DIR_PREFIX));
          await chmod(dir, 0o700);
          cacheDir = dir;
          return dir;
        } catch (err) {
          cacheDirPromise = undefined;
          if (dir) {
            await rm(dir, { recursive: true, force: true }).catch(() => {});
          }
          throw err;
        }
      })();
    }
    return cacheDirPromise;
  }

  async function readCachedResult(normalizedUrl: string): Promise<ExaContentResult | undefined> {
    return enqueueCacheTask(async () => {
      const entry = cacheEntries.get(normalizedUrl);
      if (!entry) {
        return undefined;
      }
      try {
        const raw = await readFile(entry.file, "utf-8");
        const parsed: unknown = JSON.parse(raw);
        const normalized = parseCachedExaContentResult(parsed);
        if (!normalized) {
          throw new Error("invalid cache entry");
        }
        // Refresh LRU order on cache hit.
        cacheEntries.delete(normalizedUrl);
        cacheEntries.set(normalizedUrl, entry);
        return normalized;
      } catch {
        cacheEntries.delete(normalizedUrl);
        await rm(entry.file, { force: true }).catch(() => {});
        return undefined;
      }
    });
  }

  async function writeCachedResult(normalizedUrl: string, result: ExaContentResult): Promise<void> {
    await enqueueCacheTask(async () => {
      const dir = await ensureCacheDir();
      const hash = createHash("sha256").update(normalizedUrl).digest("hex");
      const suffix = randomBytes(8).toString("hex");
      const finalPath = join(dir, `${hash}-${suffix}.json`);
      const tmpPath = `${finalPath}.tmp`;
      const payload: ExaContentResult = { title: result.title, url: result.url, text: result.text };
      try {
        await writeFile(tmpPath, JSON.stringify(payload), { mode: 0o600 });
        await rename(tmpPath, finalPath);
      } catch (err) {
        await rm(tmpPath, { force: true }).catch(() => {});
        throw err;
      }

      const previous = cacheEntries.get(normalizedUrl);
      cacheEntries.delete(normalizedUrl);
      cacheEntries.set(normalizedUrl, { file: finalPath });
      if (previous && previous.file !== finalPath) {
        await rm(previous.file, { force: true }).catch(() => {});
      }

      while (cacheEntries.size > CACHE_MAX_ENTRIES) {
        const oldestKey = cacheEntries.keys().next().value;
        if (oldestKey === undefined) {
          break;
        }
        const oldestEntry = cacheEntries.get(oldestKey);
        cacheEntries.delete(oldestKey);
        if (oldestEntry) {
          await rm(oldestEntry.file, { force: true }).catch(() => {});
        }
      }
    });
  }

  async function deleteCachedResult(normalizedUrl: string): Promise<void> {
    await enqueueCacheTask(async () => {
      const entry = cacheEntries.get(normalizedUrl);
      if (!entry) {
        return;
      }
      cacheEntries.delete(normalizedUrl);
      await rm(entry.file, { force: true }).catch(() => {});
    });
  }

  api.on("session_shutdown", async () => {
    await enqueueCacheTask(async () => {
      const dir = cacheDir;
      cacheEntries.clear();
      cacheDir = undefined;
      cacheDirPromise = undefined;
      if (dir) {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }).catch(() => {});
  });

  api.registerTool({
    name: "web_read",
    label: "Read Web Page",
    description:
      "Fetch and read the content of a web page as Markdown. Output is truncated to 2000 lines or 50KB (whichever is hit first), keeping the beginning of the content. Pass the offset value returned by a previous call to continue reading a long page; omit or use 0 to fetch fresh content from the start.",
    parameters: Type.Object(
      {
        url: Type.String({ description: "Absolute http(s) URL to read.", minLength: 1 }),
        offset: Type.Optional(
          Type.Integer({
            minimum: 0,
            description:
              "Continuation offset into the previously returned page text to continue reading from. Copy the exact nextOffset value from a prior web_read result; do not calculate it yourself. Omit or use 0 to fetch fresh content from the start.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    renderCall(args, theme, context) {
      const title = theme.fg("toolTitle", theme.bold("web_read "));
      const url = typeof args?.url === "string" ? args.url : "";
      const offset = typeof args?.offset === "number" && args.offset > 0 ? args.offset : undefined;
      if (context.expanded) {
        const suffix = offset !== undefined ? theme.fg("dim", ` (offset: ${offset})`) : "";
        return new Text(`${title}${theme.fg("accent", url)}${suffix}`, 0, 0);
      }
      const display = truncateForDisplay(
        offset !== undefined ? `${url} (offset: ${offset})` : url,
        CALL_PREVIEW_MAX_CHARS,
      );
      return new TruncatedText(`${title}${theme.fg("accent", display)}`, 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      if (isPartial) {
        return new TruncatedText(theme.fg("dim", "Reading\u2026"), 0, 0);
      }
      if (context.isError) {
        return new TruncatedText(theme.fg("dim", "failed"), 0, 0);
      }

      const content = result.content[0];
      const text = content?.type === "text" ? content.text : "";

      if (expanded) {
        return new Text(text, 0, 0);
      }

      const details = result.details as WebReadToolDetails | undefined;
      if (!details) {
        return new TruncatedText(theme.fg("muted", "done"), 0, 0);
      }

      const base = details.title ? `${details.title} \u2014 ${details.source}` : details.source;
      let line = theme.fg("muted", truncateForDisplay(base, DISPLAY_LINE_MAX_CHARS));
      if (details.truncated) {
        const continuation = details.nextOffset !== undefined ? `more: offset ${details.nextOffset}` : "more";
        line += theme.fg("dim", ` (${continuation})`);
      }
      return new TruncatedText(line, 0, 0);
    },
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const rawUrl = typeof params?.url === "string" ? params.url.trim() : "";
      if (!isNonEmptyString(rawUrl) || !isHttpUrl(rawUrl)) {
        throw new Error("web_read: url must be an absolute http or https URL");
      }

      const rawOffset = params?.offset;
      let offset = 0;
      if (rawOffset !== undefined) {
        if (typeof rawOffset !== "number" || !Number.isInteger(rawOffset) || rawOffset < 0) {
          throw new Error("web_read: offset must be a non-negative integer");
        }
        offset = rawOffset;
      }

      const apiKey = process.env.EXA_API_KEY?.trim();
      if (!isNonEmptyString(apiKey)) {
        throw new Error("web_read: missing EXA_API_KEY");
      }

      const normalizedUrl = new URL(rawUrl).toString();

      let result: ExaContentResult;
      let servedFromCache = false;
      if (offset > 0) {
        const cached = await readCachedResult(normalizedUrl);
        if (cached) {
          result = cached;
          servedFromCache = true;
        } else {
          result = await fetchExaContent(normalizedUrl, signal);
        }
      } else {
        result = await fetchExaContent(normalizedUrl, signal);
      }

      if (offset >= result.text.length) {
        throw new Error("web_read: offset is at or beyond the end of the page content");
      }

      const header = result.title ? `# ${result.title}\nSource: ${result.url}\n\n` : `Source: ${result.url}\n\n`;
      const headerBytes = Buffer.byteLength(header, "utf-8");
      const headerLines = (header.match(/\n/g) ?? []).length;

      const availableMaxBytes = Math.max(1, DEFAULT_MAX_BYTES - headerBytes - OFFSET_MARKER_RESERVE_BYTES);
      const availableMaxLines = Math.max(1, DEFAULT_MAX_LINES - headerLines - OFFSET_MARKER_RESERVE_LINES);

      const remainingText = result.text.slice(offset);
      const truncated = truncateHead(remainingText, {
        maxLines: availableMaxLines,
        maxBytes: availableMaxBytes,
      });

      let chunkContent = truncated.content;
      if (truncated.truncated && truncated.content.length === 0) {
        chunkContent = takeUtf8BytePrefix(remainingText, availableMaxBytes);
        if (chunkContent.length === 0) {
          throw new Error("web_read: page content cannot be chunked");
        }
      }

      const nextOffset = offset + chunkContent.length;
      const hasMore = nextOffset < result.text.length;

      let resultText = header + chunkContent;
      if (hasMore) {
        resultText += buildOffsetMarker(offset, nextOffset, result.text.length);
      }

      const details: WebReadToolDetails = {
        title: result.title,
        source: result.url,
        truncated: hasMore,
        offset,
        totalLength: result.text.length,
        ...(hasMore ? { nextOffset } : {}),
      };

      if (hasMore) {
        if (!servedFromCache) {
          await writeCachedResult(normalizedUrl, result).catch(() => {});
        }
      } else {
        await deleteCachedResult(normalizedUrl).catch(() => {});
      }

      return {
        content: [{ type: "text", text: resultText }],
        details,
      };
    },
  });

  api.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web via Exa and return up to 5 results as Markdown with source URLs and short excerpts. Use web_read on a returned URL to fetch full page content.",
    parameters: Type.Object(
      {
        query: Type.String({ description: "Search query.", minLength: 1 }),
      },
      { additionalProperties: false },
    ),
    renderCall(args, theme, context) {
      const title = theme.fg("toolTitle", theme.bold("web_search "));
      const query = typeof args?.query === "string" ? args.query : "";
      if (context.expanded) {
        return new Text(`${title}${theme.fg("accent", query)}`, 0, 0);
      }
      const display = truncateForDisplay(query, CALL_PREVIEW_MAX_CHARS);
      return new TruncatedText(`${title}${theme.fg("accent", display)}`, 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      if (isPartial) {
        return new TruncatedText(theme.fg("dim", "Searching\u2026"), 0, 0);
      }
      if (context.isError) {
        return new TruncatedText(theme.fg("dim", "failed"), 0, 0);
      }

      const content = result.content[0];
      const text = content?.type === "text" ? content.text : "";

      if (expanded) {
        return new Text(text, 0, 0);
      }

      const details = result.details as WebSearchToolDetails | undefined;
      if (!details) {
        return new TruncatedText(theme.fg("muted", "done"), 0, 0);
      }

      let summary =
        details.resultCount === 0
          ? "No results"
          : details.resultCount === 1
            ? "1 result"
            : `${details.resultCount} results`;
      if (details.omitted > 0) {
        summary += `, ${details.omitted} omitted`;
      }

      let line = theme.fg("muted", summary);
      if (details.truncated) {
        line += theme.fg("dim", " (truncated)");
      }
      return new TruncatedText(line, 0, 0);
    },
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const rawQuery = typeof params?.query === "string" ? params.query.trim() : "";
      if (!isNonEmptyString(rawQuery)) {
        throw new Error("web_search: query must not be empty");
      }

      const body = await callExaApi(
        "web_search",
        EXA_SEARCH_URL,
        {
          query: rawQuery,
          numResults: SEARCH_MAX_RESULTS,
          contents: { text: { maxCharacters: SEARCH_EXCERPT_MAX_CHARS } },
        },
        signal,
      );

      const { results, omitted } = parseSearchResults(body);
      const markdown = buildSearchMarkdown(results, omitted);

      const truncated = truncateHead(markdown, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });

      let resultText = truncated.content;
      if (truncated.truncated) {
        resultText += `\n\n[Showing first ${truncated.outputLines} of ${truncated.totalLines} lines, ${formatSize(
          truncated.outputBytes,
        )} of ${formatSize(truncated.totalBytes)}]`;
      }

      const details: WebSearchToolDetails = {
        resultCount: results.length,
        omitted,
        truncated: truncated.truncated,
      };

      return {
        content: [{ type: "text", text: resultText }],
        details,
      };
    },
  });
}
