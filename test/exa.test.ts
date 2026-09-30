import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "../src/provider-routing";
import { callExaApi, createExaProvider, fetchExaContent } from "../src/providers/exa";

const resolveKey = vi.hoisted(() => vi.fn<() => Promise<string | undefined>>());
vi.mock("../src/credentials", () => ({ resolveExaApiKey: resolveKey }));

const url = "https://example.com/page";
const secret = "private-exa-token";

function mock(body: unknown, status = 200) {
  const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  resolveKey.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("keyed Exa route", () => {
  it("is available only when the credential resolver supplies a key", async () => {
    resolveKey.mockResolvedValueOnce(undefined).mockResolvedValueOnce("  ").mockResolvedValue(secret);
    await expect(createExaProvider()).resolves.toBeUndefined();
    await expect(createExaProvider()).resolves.toBeUndefined();
    expect(await createExaProvider()).toMatchObject({
      name: "exa",
      mode: "keyed",
      search: expect.any(Function),
      read: expect.any(Function),
    });
    expect(resolveKey).toHaveBeenCalledTimes(3);
  });

  it("uses the existing authenticated search payload and normalizes search results", async () => {
    resolveKey.mockResolvedValue(secret);
    const route = await createExaProvider();
    const fetchMock = mock({
      results: [
        { url: `  ${url}  `, title: `  ${"T".repeat(210)}  `, text: `  ${"s".repeat(510)}  ` },
        { url: "javascript:bad", text: "skip" },
        { url: `https://example.com/${"x".repeat(2049)}` },
        { url: "https://example.com/2", title: 7, text: null },
      ],
    });
    await expect(route?.search("query")).resolves.toEqual([
      { url, title: `${"T".repeat(199)}…`, snippet: "s".repeat(500) },
      { url: "https://example.com/2", title: undefined, snippet: undefined },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [endpoint, init] = fetchMock.mock.calls[0];
    expect(endpoint).toBe("https://api.exa.ai/search");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("x-api-key")).toBe(secret);
    expect(JSON.parse(init?.body as string)).toEqual({
      query: "query",
      numResults: 5,
      contents: { text: { maxCharacters: 500 } },
    });
    expect(resolveKey).toHaveBeenCalledTimes(2);
  });

  it("accepts empty search results, but treats malformed responses as transient", async () => {
    resolveKey.mockResolvedValue(secret);
    const route = await createExaProvider();
    mock({ results: [] });
    await expect(route?.search("query")).resolves.toEqual([]);
    mock({ results: [{ url: "ftp://example.com" }] });
    await expect(route?.search("query")).rejects.toEqual(new ProviderError("transient"));
    mock({ results: "bad" });
    await expect(route?.search("query")).rejects.toEqual(new ProviderError("transient"));
  });

  it("reads through the existing Exa content parser", async () => {
    resolveKey.mockResolvedValue(secret);
    const route = await createExaProvider();
    const fetchMock = mock({ results: [{ url: ` ${url} `, title: " Page ", text: "  Full page\ntext  " }] });
    await expect(route?.read(url)).resolves.toEqual({ url, title: "Page", text: "Full page\ntext" });
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.exa.ai/contents");
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toEqual({ urls: [url], text: true });
    mock({ results: [{ url, text: " " }] });
    await expect(route?.read(url)).rejects.toEqual(new ProviderError("transient"));
  });

  it.each([
    [401, "invalid-credentials"],
    [402, "quota"],
    [429, "rate-limit"],
    [503, "transient"],
  ] as const)("maps HTTP %i without exposing provider response text", async (status, kind) => {
    resolveKey.mockResolvedValue(secret);
    const route = await createExaProvider();
    mock({ error: secret }, status);
    await expect(route?.search("query")).rejects.toEqual(new ProviderError(kind));
    await expect(route?.read(url)).rejects.toEqual(new ProviderError(kind));
  });

  it("maps a missing credential after route creation without changing the legacy error", async () => {
    resolveKey.mockResolvedValueOnce(secret).mockResolvedValue(undefined);
    const route = await createExaProvider();
    await expect(route?.search("query")).rejects.toEqual(new ProviderError("invalid-credentials"));
    await expect(route?.read(url)).rejects.toEqual(new ProviderError("invalid-credentials"));
  });

  it("uses valid Retry-After seconds and HTTP dates for keyed rate limits", async () => {
    resolveKey.mockResolvedValue(secret);
    const route = await createExaProvider();
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("Wed, 21 Oct 2015 07:28:00 GMT"));
    for (const [header, delay] of [
      ["12", 12_000],
      ["Wed, 21 Oct 2015 07:28:07 GMT", 7_000],
      ["not a date", undefined],
      ["-5", undefined],
      ["9".repeat(310), undefined],
    ] as const) {
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(
          async () =>
            new Response(JSON.stringify({ error: secret }), {
              status: 429,
              headers: { "Retry-After": header },
            }),
        ),
      );
      await expect(route?.search("query")).rejects.toEqual(new ProviderError("rate-limit", delay));
      await expect(route?.read(url)).rejects.toEqual(new ProviderError("rate-limit", delay));
    }
  });

  it("propagates caller cancellation and maps timeout, network and invalid JSON to transient", async () => {
    resolveKey.mockResolvedValue(secret);
    const route = await createExaProvider();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            if (init?.signal?.aborted) reject(new Error(secret));
            else init?.signal?.addEventListener("abort", () => reject(new Error(secret)), { once: true });
          }),
      ),
    );
    const controller = new AbortController();
    const pending = route?.search("query", controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });

    const timeout = new AbortController();
    const spy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    const timed = route?.read(url);
    await vi.waitFor(() => expect(spy).toHaveBeenCalledWith(30_000));
    timeout.abort();
    await expect(timed).rejects.toEqual(new ProviderError("transient"));
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => {
        throw new Error(secret);
      }),
    );
    await expect(route?.search("query")).rejects.toEqual(new ProviderError("transient"));
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response(secret)),
    );
    await expect(route?.read(url)).rejects.toEqual(new ProviderError("transient"));
  });

  it("leaves public legacy methods and their fixed errors unchanged", async () => {
    resolveKey.mockResolvedValue(undefined);
    await expect(callExaApi("web_search", "https://api.exa.ai/search", {}, undefined)).rejects.toThrow(
      "web_search: missing EXA_API_KEY; run /scryer login (macOS) or set EXA_API_KEY",
    );
    resolveKey.mockResolvedValue(secret);
    mock({ error: secret }, 401);
    await expect(callExaApi("web_search", "https://api.exa.ai/search", {}, undefined)).rejects.toThrow(
      "web_search: invalid API key",
    );
    mock({ error: secret }, 402);
    await expect(callExaApi("web_search", "https://api.exa.ai/search", {}, undefined)).rejects.toThrow(
      "web_search: quota exceeded or payment required",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        async () =>
          new Response(JSON.stringify({ error: secret }), {
            status: 429,
            headers: { "Retry-After": "12" },
          }),
      ),
    );
    await expect(callExaApi("web_search", "https://api.exa.ai/search", {}, undefined)).rejects.toThrow(
      "web_search: rate limited",
    );
    mock({ results: [{ url, text: "  Legacy text  " }] });
    await expect(fetchExaContent(url, undefined)).resolves.toEqual({ url, title: undefined, text: "Legacy text" });
    mock({ results: [] });
    await expect(fetchExaContent(url, undefined)).rejects.toThrow("web_read: no content returned for this URL");
  });
});
