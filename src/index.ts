import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type ExtensionAPI,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const EXA_CONTENTS_URL = "https://api.exa.ai/contents";
const EXA_SEARCH_URL = "https://api.exa.ai/search";
const REQUEST_TIMEOUT_MS = 30_000;
const SEARCH_MAX_RESULTS = 5;
const SEARCH_EXCERPT_MAX_CHARS = 500;
const SEARCH_TITLE_MAX_CHARS = 200;
const SEARCH_URL_MAX_CHARS = 2048;
const CALL_PREVIEW_MAX_CHARS = 80;
const DISPLAY_LINE_MAX_CHARS = 80;

interface WebReadToolDetails {
  title?: string;
  source: string;
  truncated: boolean;
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
    const title = isNonEmptyString(rawTitle) ? rawTitle.trim().slice(0, SEARCH_TITLE_MAX_CHARS) : undefined;
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
  return {
    title: isNonEmptyString(title) ? title.trim() : undefined,
    url: url.trim(),
    text: text.trim(),
  };
}

export default function activate(api: ExtensionAPI): void {
  api.registerTool({
    name: "web_read",
    label: "Read Web Page",
    description:
      "Fetch and read the content of a web page as Markdown. Output is truncated to 2000 lines or 50KB (whichever is hit first), keeping the beginning of the content.",
    parameters: Type.Object(
      {
        url: Type.String({ description: "Absolute http(s) URL to read.", minLength: 1 }),
      },
      { additionalProperties: false },
    ),
    renderCall(args, theme, context) {
      const title = theme.fg("toolTitle", theme.bold("web_read "));
      const url = typeof args?.url === "string" ? args.url : "";
      const display = context.expanded ? url : truncateForDisplay(url, CALL_PREVIEW_MAX_CHARS);
      return new Text(`${title}${theme.fg("accent", display)}`, 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      if (isPartial) {
        return new Text(theme.fg("dim", "Reading\u2026"), 0, 0);
      }
      if (context.isError) {
        return new Text(theme.fg("dim", "failed"), 0, 0);
      }

      const content = result.content[0];
      const text = content?.type === "text" ? content.text : "";

      if (expanded) {
        return new Text(text, 0, 0);
      }

      const details = result.details as WebReadToolDetails | undefined;
      if (!details) {
        return new Text(theme.fg("muted", "done"), 0, 0);
      }

      const base = details.title ? `${details.title} \u2014 ${details.source}` : details.source;
      let line = theme.fg("muted", truncateForDisplay(base, DISPLAY_LINE_MAX_CHARS));
      if (details.truncated) {
        line += theme.fg("dim", " (truncated)");
      }
      return new Text(line, 0, 0);
    },
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const rawUrl = typeof params?.url === "string" ? params.url.trim() : "";
      if (!isNonEmptyString(rawUrl) || !isHttpUrl(rawUrl)) {
        throw new Error("web_read: url must be an absolute http or https URL");
      }

      const apiKey = process.env.EXA_API_KEY?.trim();
      if (!isNonEmptyString(apiKey)) {
        throw new Error("web_read: missing EXA_API_KEY");
      }

      const normalizedUrl = new URL(rawUrl).toString();

      const body = await callExaApi("web_read", EXA_CONTENTS_URL, { urls: [normalizedUrl], text: true }, signal);

      const result = parseFirstResult(body);
      const markdown = result.title
        ? `# ${result.title}\nSource: ${result.url}\n\n${result.text}`
        : `Source: ${result.url}\n\n${result.text}`;

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

      const details: WebReadToolDetails = {
        title: result.title,
        source: result.url,
        truncated: truncated.truncated,
      };

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
      const display = context.expanded ? query : truncateForDisplay(query, CALL_PREVIEW_MAX_CHARS);
      return new Text(`${title}${theme.fg("accent", display)}`, 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      if (isPartial) {
        return new Text(theme.fg("dim", "Searching\u2026"), 0, 0);
      }
      if (context.isError) {
        return new Text(theme.fg("dim", "failed"), 0, 0);
      }

      const content = result.content[0];
      const text = content?.type === "text" ? content.text : "";

      if (expanded) {
        return new Text(text, 0, 0);
      }

      const details = result.details as WebSearchToolDetails | undefined;
      if (!details) {
        return new Text(theme.fg("muted", "done"), 0, 0);
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
      return new Text(line, 0, 0);
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
