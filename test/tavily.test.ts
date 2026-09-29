import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "../src/provider-routing";
import { createTavilyProvider } from "../src/tavily";

const originalKey = process.env.TAVILY_API_KEY;
const secret = "private-tavily-token";
const pageUrl = "https://example.com/page";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function mockFetch(body: unknown, status = 200) {
  const fetchMock = vi.fn<typeof fetch>(async () => json(body, status));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  if (originalKey === undefined) delete process.env.TAVILY_API_KEY;
  else process.env.TAVILY_API_KEY = originalKey;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Tavily provider", () => {
  it("creates only anonymous routes without a nonblank key", () => {
    process.env.TAVILY_API_KEY = "  ";
    expect(createTavilyProvider().name).toBe("tavily");
    expect(createTavilyProvider().keyed).toBeUndefined();
    expect(createTavilyProvider().anonymous).toHaveProperty("read");
    expect(createTavilyProvider().anonymous).toHaveProperty("search");
  });

  it("searches in keyed and keyless modes with isolated headers and normalized hits", async () => {
    process.env.TAVILY_API_KEY = `  ${secret}  `;
    const fetchMock = mockFetch({
      results: [{ title: " Title ", url: ` ${pageUrl} `, content: " Excerpt " }, { url: "bad" }],
    });
    const provider = createTavilyProvider();
    for (const route of [provider.keyed, provider.anonymous]) {
      await expect(route?.search("query")).resolves.toEqual([{ title: "Title", url: pageUrl, snippet: "Excerpt" }]);
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [index, [url, init]] of fetchMock.mock.calls.entries()) {
      expect(url).toBe("https://api.tavily.com/search");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init?.body as string)).toEqual({ query: "query", max_results: 5, include_answer: false });
      const headers = new Headers(init?.headers);
      expect(headers.get("content-type")).toBe("application/json");
      expect(headers.get("authorization")).toBe(index === 0 ? `Bearer ${secret}` : null);
      expect(headers.get("X-Tavily-Access-Mode")).toBe(index === 0 ? null : "keyless");
      expect(init?.signal).toBeDefined();
    }
  });

  it("extracts in both modes using the resolved URL and optional title", async () => {
    process.env.TAVILY_API_KEY = secret;
    const fetchMock = mockFetch({ results: [{ url: " https://resolved.example/ ", raw_content: " Page content " }] });
    const provider = createTavilyProvider();
    for (const route of [provider.keyed, provider.anonymous]) {
      await expect(route?.read(pageUrl)).resolves.toEqual({
        url: "https://resolved.example/",
        title: undefined,
        text: "Page content",
      });
    }
    for (const [index, [url, init]] of fetchMock.mock.calls.entries()) {
      expect(url).toBe("https://api.tavily.com/extract");
      expect(JSON.parse(init?.body as string)).toEqual({ urls: [pageUrl] });
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(index === 0 ? `Bearer ${secret}` : null);
      expect(headers.get("X-Tavily-Access-Mode")).toBe(index === 0 ? null : "keyless");
    }
  });

  it.each([
    [402, { error: { message: secret } }, "quota", undefined],
    [400, { error: { code: "QUOTA_EXCEEDED", message: secret } }, "quota", undefined],
    [401, { detail: secret }, "invalid-credentials", undefined],
    [403, { detail: secret }, "invalid-credentials", undefined],
    [429, { error: { retry_after_seconds: 4, message: secret } }, "rate-limit", 4000],
    [503, { detail: secret }, "transient", undefined],
  ] as const)("classifies keyed HTTP %i without leaking data", async (status, body, kind, retryAfterMs) => {
    process.env.TAVILY_API_KEY = secret;
    mockFetch(body, status);
    await expect(createTavilyProvider().keyed?.search("query")).rejects.toEqual(new ProviderError(kind, retryAfterMs));
  });

  it("classifies a keyless limit envelope and its retry delay even with HTTP 200", async () => {
    process.env.TAVILY_API_KEY = secret;
    mockFetch({ error: { code: "KEYLESS_LIMIT", retry_after_seconds: 12, message: secret } });
    await expect(createTavilyProvider().anonymous?.read(pageUrl)).rejects.toMatchObject({
      kind: "rate-limit",
      retryAfterMs: 12000,
    });
  });

  it.each([
    [{ results: "wrong" }, "search"],
    [{ results: [{ url: "not-a-url" }] }, "search"],
    [{ results: [] }, "read"],
    [{ results: [{ url: pageUrl, raw_content: " " }] }, "read"],
    [{ results: [{ url: "javascript:bad", raw_content: "content" }] }, "read"],
  ] as const)("rejects malformed %s for %s", async (body, operation) => {
    mockFetch(body);
    const route = createTavilyProvider().anonymous;
    const pending = operation === "search" ? route?.search("query") : route?.read(pageUrl);
    await expect(pending).rejects.toMatchObject({ kind: "transient" });
  });

  it("treats malformed JSON and network failures as transient without exposing secret responses", async () => {
    process.env.TAVILY_API_KEY = secret;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response(secret)),
    );
    await expect(createTavilyProvider().keyed?.search("query")).rejects.toEqual(new ProviderError("transient"));
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => {
        throw new Error(secret);
      }),
    );
    await expect(createTavilyProvider().keyed?.read(pageUrl)).rejects.toEqual(new ProviderError("transient"));
  });

  it("returns empty search results without treating them as malformed", async () => {
    mockFetch({ results: [] });
    await expect(createTavilyProvider().anonymous?.search("query")).resolves.toEqual([]);
  });

  it("maps timeouts to transient errors", async () => {
    const timeout = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error(secret)), { once: true });
          }),
      ),
    );
    const pending = createTavilyProvider().anonymous?.read(pageUrl);
    expect(timeoutSpy).toHaveBeenCalledWith(30_000);
    timeout.abort();
    await expect(pending).rejects.toEqual(new ProviderError("transient"));
  });

  it("cancels caller requests instead of turning them into transient errors", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error(secret)), { once: true });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const pending = createTavilyProvider().anonymous?.search("query", controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
