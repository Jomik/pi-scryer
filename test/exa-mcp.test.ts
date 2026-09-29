import { afterEach, describe, expect, it, vi } from "vitest";
import { createExaMcpProvider } from "../src/exa-mcp";
import { ProviderError } from "../src/provider-routing";

const url = "https://example.com/page";
const secret = "private-exa-token";
const originalKey = process.env.EXA_API_KEY;

function json(result: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(result), { status, headers: { "content-type": "application/json", ...headers } });
}

function result(text: string, isError = false) {
  return { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }], isError } };
}

function mock(response: Response) {
  const fetchMock = vi.fn<typeof fetch>(async () => response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  if (originalKey === undefined) delete process.env.EXA_API_KEY;
  else process.env.EXA_API_KEY = originalKey;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("anonymous Exa MCP provider", () => {
  it("uses default tools without ever sending the configured API key", async () => {
    process.env.EXA_API_KEY = secret;
    const fetchMock = mock(json(result(`Title: Title\nURL: ${url}\nHighlights:\nSnippet`)));
    const provider = createExaMcpProvider();
    expect(provider.name).toBe("exa");
    expect(provider.keyed).toBeUndefined();
    await expect(provider.anonymous?.search("query")).resolves.toEqual([{ url, title: "Title", snippet: "Snippet" }]);
    const readMock = mock(json(result(`# Title\nURL: ${url}\n\nEntire page\nsecond line`)));
    await expect(provider.anonymous?.read(url)).resolves.toEqual({
      url,
      title: "Title",
      text: "Entire page\nsecond line",
    });
    for (const [index, [endpoint, init]] of [fetchMock.mock.calls[0], readMock.mock.calls[0]].entries()) {
      expect(endpoint).toBe("https://mcp.exa.ai/mcp");
      expect(init?.method).toBe("POST");
      const headers = new Headers(init?.headers);
      expect(headers.get("content-type")).toBe("application/json");
      expect(headers.get("accept")).toBe("application/json,text/event-stream");
      expect(headers.get("authorization")).toBeNull();
      expect(headers.get("x-api-key")).toBeNull();
      expect(JSON.stringify([endpoint, init?.headers, init?.body])).not.toContain(secret);
      expect(JSON.parse(init?.body as string)).toEqual({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params:
          index === 0
            ? { name: "web_search_exa", arguments: { query: "query", numResults: 5 } }
            : { name: "web_fetch_exa", arguments: { urls: [url], maxCharacters: 100000 } },
      });
    }
  });

  it("parses SSE frames and bounds search hits to five validated URLs", async () => {
    const entries = [
      "Title: Bad\nURL: javascript:alert(1)\nText: skip",
      ...Array.from(
        { length: 7 },
        (_, i) => `Title: ${i}\nURL: https://example.com/${i}\nPublished: N/A\nText: excerpt ${i}`,
      ),
    ];
    const sse = `: ping\n\nevent: message\ndata: ${JSON.stringify(result(entries.join("\n\n---\n\n")))}\n\n`;
    mock(new Response(sse, { headers: { "content-type": "text/event-stream" } }));
    const hits = await createExaMcpProvider().anonymous?.search("query");
    expect(hits).toHaveLength(5);
    expect(hits?.[0]).toEqual({ url: "https://example.com/0", title: "0", snippet: "excerpt 0" });
  });

  it("parses multiline SSE data and full read text with metadata and optional title", async () => {
    const payload = JSON.stringify(
      result(`# (no title)\nURL: ${url}\nPublished: 2025-01-01\nAuthor: Someone\n\nFirst\n\nLast`),
    );
    mock(new Response(`event: message\ndata: ${payload}\n\n`, { headers: { "content-type": "text/event-stream" } }));
    await expect(createExaMcpProvider().anonymous?.read(url)).resolves.toEqual({
      url,
      title: undefined,
      text: "First\n\nLast",
    });
  });

  it("returns empty search messages and rejects malformed search or read output", async () => {
    const route = createExaMcpProvider().anonymous;
    mock(json(result("No search results found. Please try a different query.")));
    await expect(route?.search("query")).resolves.toEqual([]);
    mock(json(result("")));
    await expect(route?.search("query")).rejects.toEqual(new ProviderError("transient"));
    mock(json(result(" \r\n\t ")));
    await expect(route?.search("query")).rejects.toEqual(new ProviderError("transient"));
    mock(json(result("Title: broken\nURL: ftp://example.com\nText: bad")));
    await expect(route?.search("query")).rejects.toEqual(new ProviderError("transient"));
    mock(json(result(`# CRLF title\r\nURL: ${url}\r\n\r\ntext`)));
    await expect(route?.read(url)).resolves.toEqual({ url, title: "CRLF title", text: "text" });
    mock(json(result(`# Title\nURL: javascript:bad\n\ntext`)));
    await expect(route?.read(url)).rejects.toEqual(new ProviderError("transient"));
    mock(json(result("No content found for the provided URL(s).")));
    await expect(route?.read(url)).rejects.toEqual(new ProviderError("transient"));
    mock(json({ jsonrpc: "2.0", id: 1, result: { content: "bad" } }));
    await expect(route?.search("query")).rejects.toEqual(new ProviderError("transient"));
  });

  it("classifies HTTP and embedded failures without exposing response text", async () => {
    const route = createExaMcpProvider().anonymous;
    mock(json({ error: secret }, 429, { "retry-after": "12" }));
    await expect(route?.search("query")).rejects.toEqual(new ProviderError("rate-limit", 12000));
    mock(json({ error: secret }, 402));
    await expect(route?.read(url)).rejects.toEqual(new ProviderError("quota"));
    mock(json(result(`Rate limit exceeded ${secret}`, true), 200, { "retry-after": "invalid" }));
    await expect(route?.search("query")).rejects.toEqual(new ProviderError("rate-limit"));
    mock(json({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: `quota exhausted ${secret}` } }));
    await expect(route?.read(url)).rejects.toEqual(new ProviderError("quota"));
    mock(json({ jsonrpc: "2.0", id: 1, error: { message: secret } }));
    await expect(route?.read(url)).rejects.toEqual(new ProviderError("transient"));
    mock(
      new Response(`event: message\ndata: ${JSON.stringify(result(`quota exceeded ${secret}`, true))}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      }),
    );
    await expect(route?.search("query")).rejects.toEqual(new ProviderError("quota"));
    mock(new Response(secret, { status: 503 }));
    await expect(route?.read(url)).rejects.toEqual(new ProviderError("transient"));
    mock(new Response(`too many requests ${secret}`, { status: 400, headers: { "retry-after": "3" } }));
    await expect(route?.search("query")).rejects.toEqual(new ProviderError("rate-limit", 3000));
    mock(new Response(`quota exceeded ${secret}`, { status: 403 }));
    await expect(route?.search("query")).rejects.toEqual(new ProviderError("quota"));
  });

  it("propagates caller abort and maps timeout and network errors to transient", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error(secret)), { once: true });
          }),
      ),
    );
    const pending = createExaMcpProvider().anonymous?.search("query", controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });

    const timeout = new AbortController();
    const spy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    const timed = createExaMcpProvider().anonymous?.read(url);
    expect(spy).toHaveBeenCalledWith(30_000);
    timeout.abort();
    await expect(timed).rejects.toEqual(new ProviderError("transient"));
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => {
        throw new Error(secret);
      }),
    );
    await expect(createExaMcpProvider().anonymous?.search("query")).rejects.toEqual(new ProviderError("transient"));
  });
});
