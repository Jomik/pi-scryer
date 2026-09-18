import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type ExtensionAPI,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const EXA_CONTENTS_URL = "https://api.exa.ai/contents";
const REQUEST_TIMEOUT_MS = 30_000;

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

function parseFirstResult(body: unknown): ExaContentResult {
  if (!isRecord(body)) {
    throw new Error("web_read: malformed response from content provider");
  }
  const statuses = body.statuses;
  if (Array.isArray(statuses)) {
    for (const entry of statuses) {
      if (isRecord(entry) && entry.status === "error") {
        const errorRecord = isRecord(entry.error) ? entry.error : undefined;
        const tag = errorRecord && isNonEmptyString(errorRecord.tag) ? errorRecord.tag.trim() : undefined;
        throw new Error(
          tag ? `web_read: Exa could not retrieve this URL (${tag})` : "web_read: Exa could not retrieve this URL",
        );
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

      const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const composedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

      let response: Response;
      try {
        response = await fetch(EXA_CONTENTS_URL, {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "content-type": "application/json",
          },
          body: JSON.stringify({ urls: [normalizedUrl], text: true }),
          signal: composedSignal,
        });
      } catch {
        if (signal?.aborted) {
          throw new Error("web_read: request cancelled");
        }
        if (timeoutSignal.aborted) {
          throw new Error("web_read: request timed out");
        }
        throw new Error("web_read: network request failed");
      }

      if (!response.ok) {
        if (response.status === 401) {
          throw new Error("web_read: invalid API key");
        }
        if (response.status === 402) {
          throw new Error("web_read: quota exceeded or payment required");
        }
        if (response.status === 429) {
          throw new Error("web_read: rate limited");
        }
        throw new Error(`web_read: request failed with status ${response.status}`);
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        if (signal?.aborted) {
          throw new Error("web_read: request cancelled");
        }
        if (timeoutSignal.aborted) {
          throw new Error("web_read: request timed out");
        }
        throw new Error("web_read: malformed JSON response from content provider");
      }

      const result = parseFirstResult(body);
      const title = result.title ?? result.url;
      const markdown = `# ${title}\nSource: ${result.url}\n\n${result.text}`;

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

      return {
        content: [{ type: "text", text: resultText }],
        details: undefined,
      };
    },
  });
}
