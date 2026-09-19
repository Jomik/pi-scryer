import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  defineTool,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Text, TruncatedText } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  callExaApi,
  EXA_SEARCH_URL,
  isHttpUrl,
  isNonEmptyString,
  isRecord,
  SEARCH_TITLE_MAX_CHARS,
  SEARCH_URL_MAX_CHARS,
  truncateForDisplay,
} from "./exa";

const SEARCH_MAX_RESULTS = 5;
const SEARCH_EXCERPT_MAX_CHARS = 500;
const CALL_PREVIEW_MAX_CHARS = 80;

interface WebSearchToolDetails {
  resultCount: number;
  omitted: number;
  truncated: boolean;
}

interface ExaSearchResult {
  title?: string;
  url: string;
  text?: string;
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

export const webSearchTool = defineTool({
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
