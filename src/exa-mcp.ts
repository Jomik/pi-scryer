import { ProviderError, type ProviderRoute, type ReadPage, type SearchHit, type WebProvider } from "./provider-routing";

const ENDPOINT = "https://mcp.exa.ai/mcp";
const TIMEOUT_MS = 30_000;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function httpUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const delay = /^\d+(?:\.\d+)?$/.test(trimmed) ? Number(trimmed) * 1000 : Date.parse(trimmed) - Date.now();
  return Number.isFinite(delay) && delay > 0 ? delay : undefined;
}

function failure(value: unknown, retryAfterMs?: number): ProviderError {
  const message = typeof value === "string" ? value : JSON.stringify(value ?? "");
  if (/quota|credit|payment|402/i.test(message)) return new ProviderError("quota");
  if (/rate[ -]?limit|too many requests|429|throttl/i.test(message)) {
    return new ProviderError("rate-limit", retryAfterMs);
  }
  return new ProviderError("transient");
}

function parseEnvelope(text: string, contentType: string | null): unknown {
  if (!contentType?.toLowerCase().includes("text/event-stream")) return JSON.parse(text);
  for (const frame of text.split(/\r?\n\r?\n/)) {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    try {
      const value: unknown = JSON.parse(data);
      if (record(value) && ("result" in value || "error" in value)) return value;
    } catch {
      // Other SSE events are not tool responses.
    }
  }
  throw new ProviderError("transient");
}

async function callTool(name: string, args: unknown, signal?: AbortSignal): Promise<string[]> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const cancelled = (): never => {
    if (signal?.aborted) throw new DOMException("Request aborted", "AbortError");
    throw new ProviderError("transient");
  };
  if (combined.aborted) cancelled();

  let response: Response;
  let text: string;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json,text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      signal: combined,
    });
    text = await response.text();
  } catch {
    if (combined.aborted) cancelled();
    throw new ProviderError("transient");
  }
  if (combined.aborted) cancelled();

  const delay = retryAfter(response.headers.get("retry-after"));
  if (response.status === 402) throw new ProviderError("quota");
  if (response.status === 429) throw new ProviderError("rate-limit", delay);

  let envelope: unknown;
  try {
    envelope = parseEnvelope(text, response.headers.get("content-type"));
  } catch {
    if (!response.ok) throw failure(text, delay);
    throw new ProviderError("transient");
  }
  if (!record(envelope)) throw new ProviderError("transient");
  if ("error" in envelope && envelope.error != null) throw failure(envelope.error, delay);
  const result = envelope.result;
  if (!response.ok) throw failure(result ?? envelope, delay);
  if (!record(result) || !Array.isArray(result.content)) throw new ProviderError("transient");
  if (result.isError === true) throw failure(result.content, delay);
  if (!result.content.every((block) => record(block) && block.type === "text" && typeof block.text === "string")) {
    throw new ProviderError("transient");
  }
  return result.content.map((block: { text: string }) => block.text);
}

function searchHits(texts: string[]): SearchHit[] {
  if (texts.length === 1 && /^(no search results found|no results found)\b/i.test(texts[0].trim())) return [];
  const hits: SearchHit[] = [];
  for (const text of texts) {
    for (const entry of text.split(/\n\s*---\s*\n/)) {
      if (!entry.trim()) continue;
      const url = httpUrl(/^URL:\s*(.+)$/im.exec(entry)?.[1]);
      if (!url) continue;
      const title = optionalText(/^Title:\s*(.*)$/im.exec(entry)?.[1]);
      const snippet = optionalText(/^(?:Highlights|Text):\s*([\s\S]*)$/im.exec(entry)?.[1]);
      hits.push({ url, title: title === "N/A" ? undefined : title, snippet });
      if (hits.length === 5) return hits;
    }
  }
  if (texts.some((text) => text.trim()) && !hits.length) throw new ProviderError("transient");
  return hits;
}

function readPage(texts: string[]): ReadPage {
  for (const text of texts) {
    const match = /^#\s+([^\n]*)\r?\nURL:\s*([^\r\n]+)\r?\n(?:[^\n]*\r?\n)*?\r?\n([\s\S]*)$/i.exec(text);
    if (!match) continue;
    const url = httpUrl(match[2]);
    const content = optionalText(match[3]);
    if (url && content) {
      const title = optionalText(match[1]);
      return { url, title: title === "(no title)" ? undefined : title, text: content };
    }
  }
  throw new ProviderError("transient");
}

export function createExaMcpProvider(): WebProvider {
  const anonymous: ProviderRoute = {
    async search(query, signal) {
      return searchHits(await callTool("web_search_exa", { query, numResults: 5 }, signal));
    },
    async read(url, signal) {
      return readPage(await callTool("web_fetch_exa", { urls: [url], maxCharacters: 100000 }, signal));
    },
  };
  return { name: "exa", anonymous };
}
