import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, defineTool, truncateHead } from "@earendil-works/pi-coding-agent";
import { Text, TruncatedText, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ContinuationCache } from "./continuation-cache";
import { type ExaContentResult, fetchExaContent, isHttpUrl, isNonEmptyString, truncateForDisplay } from "./exa";

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
 * Creates the web_read tool definition, bound to the given continuation
 * cache instance.
 */
export function createWebReadTool(cache: ContinuationCache) {
  return defineTool({
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
      const suffix = offset !== undefined ? theme.fg("warning", ` (offset: ${offset})`) : "";
      if (context.expanded) {
        return new Text(`${title}${theme.fg("accent", url)}${suffix}`, 0, 0);
      }
      const display = truncateForDisplay(url, CALL_PREVIEW_MAX_CHARS);
      return {
        render(width: number) {
          const preview = truncateToWidth(display, Math.max(1, width - visibleWidth(title + suffix)), "…");
          return new TruncatedText(`${title}${theme.fg("accent", preview)}${suffix}`, 0, 0).render(width);
        },
        invalidate() {},
      };
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

      const base = truncateForDisplay(
        details.title ? `${details.title} \u2014 ${details.source}` : details.source,
        DISPLAY_LINE_MAX_CHARS,
      );
      const more = details.nextOffset !== undefined ? theme.fg("warning", ` (more: offset ${details.nextOffset})`) : "";
      const range =
        details.offset > 0 || details.truncated
          ? ` (offsets ${details.offset}-${(details.nextOffset ?? details.totalLength) - 1} of ${details.totalLength})`
          : "";
      return {
        render(width: number) {
          const preview = truncateToWidth(base, Math.max(1, width - visibleWidth(more)), "…");
          const summary = theme.fg("muted", preview) + more;
          const rangeLabel = visibleWidth(summary + range) <= width ? theme.fg("dim", range) : "";
          return new TruncatedText(summary + rangeLabel, 0, 0).render(width);
        },
        invalidate() {},
      };
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

      const normalizedUrl = new URL(rawUrl).toString();

      let result: ExaContentResult;
      let servedFromCache = false;
      if (offset > 0) {
        const cached = await cache.readCachedResult(normalizedUrl);
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
          await cache.writeCachedResult(normalizedUrl, result).catch(() => {});
        }
      } else {
        await cache.deleteCachedResult(normalizedUrl).catch(() => {});
      }

      return {
        content: [{ type: "text", text: resultText }],
        details,
      };
    },
  });
}
