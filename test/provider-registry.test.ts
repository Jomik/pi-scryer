import { afterEach, describe, expect, it, vi } from "vitest";
import { createProviderRouter } from "../src/provider-routing";
import { createProviderRegistry } from "../src/providers/registry";

const resolveKey = vi.hoisted(() => vi.fn<() => Promise<string | undefined>>());
vi.mock("../src/credentials", () => ({ resolveExaApiKey: resolveKey }));

const url = "https://example.com/page";
const exaKey = "test-exa-key";
const tavilyKey = "test-tavily-key";

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function success(endpoint: string, init?: RequestInit) {
  if (endpoint === "https://mcp.exa.ai/mcp") {
    const { params } = JSON.parse(init?.body as string);
    const text =
      params.name === "web_search_exa" ? `Title: Title\nURL: ${url}\nText: Content` : `# Title\nURL: ${url}\n\nContent`;
    return json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }] } });
  }
  return json({ results: [{ url, title: "Title", text: "Content", content: "Content", raw_content: "Content" }] });
}

afterEach(() => {
  resolveKey.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("provider registry", () => {
  it("loads Exa credentials lazily and returns only two direct anonymous providers without keys", async () => {
    resolveKey.mockResolvedValue(undefined);
    vi.stubEnv("TAVILY_API_KEY", "");
    const loadProviders = createProviderRegistry();
    expect(resolveKey).not.toHaveBeenCalled();

    const providers = await loadProviders();
    expect(resolveKey).toHaveBeenCalledTimes(1);
    expect(providers.map(({ name, mode }) => ({ name, mode }))).toEqual([
      { name: "exa-anon", mode: "anonymous" },
      { name: "tavily-anon", mode: "anonymous" },
    ]);
    for (const provider of providers) {
      expect(provider).toMatchObject({ search: expect.any(Function), read: expect.any(Function) });
      expect(provider).not.toHaveProperty("keyed");
      expect(provider).not.toHaveProperty("anonymous");
    }
  });

  it("returns exactly four named direct providers with isolated search and read headers when both keys exist", async () => {
    resolveKey.mockResolvedValue(exaKey);
    vi.stubEnv("TAVILY_API_KEY", tavilyKey);
    const providers = await createProviderRegistry()();
    expect(providers.map(({ name, mode }) => ({ name, mode }))).toEqual([
      { name: "exa", mode: "keyed" },
      { name: "exa-anon", mode: "anonymous" },
      { name: "tavily", mode: "keyed" },
      { name: "tavily-anon", mode: "anonymous" },
    ]);
    expect(new Set(providers.map(({ name }) => name)).size).toBe(4);
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => success(String(input), init));
    vi.stubGlobal("fetch", fetchMock);

    for (const provider of providers) {
      expect(provider).not.toHaveProperty("keyed");
      expect(provider).not.toHaveProperty("anonymous");
      await expect(provider.search("query")).resolves.toEqual([{ url, title: "Title", snippet: "Content" }]);
      await expect(provider.read(url)).resolves.toEqual({ url, title: "Title", text: "Content" });
    }
    expect(fetchMock).toHaveBeenCalledTimes(8);
    const endpoints = [
      "https://api.exa.ai/search",
      "https://api.exa.ai/contents",
      "https://mcp.exa.ai/mcp",
      "https://mcp.exa.ai/mcp",
      "https://api.tavily.com/search",
      "https://api.tavily.com/extract",
      "https://api.tavily.com/search",
      "https://api.tavily.com/extract",
    ];
    for (const [index, [endpoint, init]] of fetchMock.mock.calls.entries()) {
      expect(endpoint).toBe(endpoints[index]);
      const headers = new Headers(init?.headers);
      expect(headers.get("x-api-key")).toBe(index < 2 ? exaKey : null);
      expect(headers.get("Authorization")).toBe(index >= 4 && index < 6 ? `Bearer ${tavilyKey}` : null);
      expect(headers.get("X-Tavily-Access-Mode")).toBe(index >= 6 ? "keyless" : null);
      expect(String(endpoint)).not.toMatch(/test-exa-key|test-tavily-key/);
      expect(init?.body).not.toMatch(/test-exa-key|test-tavily-key/);
    }
  });

  it("captures Tavily's environment key at factory creation, not loading", async () => {
    resolveKey.mockResolvedValue(undefined);
    vi.stubEnv("TAVILY_API_KEY", "  activation-key  ");
    const loadProviders = createProviderRegistry();
    vi.stubEnv("TAVILY_API_KEY", "later-key");
    const providers = await loadProviders();
    const tavily = providers.find(({ name }) => name === "tavily");
    expect(tavily).toBeDefined();
    const fetchMock = vi.fn<typeof fetch>(async () => json({ results: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await tavily?.search("query");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("Authorization")).toBe("Bearer activation-key");
  });

  it("resolves keyed Exa existence on each load without mutating earlier entries", async () => {
    resolveKey.mockResolvedValueOnce(exaKey).mockResolvedValueOnce(undefined);
    vi.stubEnv("TAVILY_API_KEY", "");
    const loadProviders = createProviderRegistry();
    const first = await loadProviders();
    const second = await loadProviders();
    expect(first.map(({ name }) => name)).toEqual(["exa", "exa-anon", "tavily-anon"]);
    expect(second.map(({ name }) => name)).toEqual(["exa-anon", "tavily-anon"]);
  });

  it("shares real-entry cooldown between search and read while keeping keyed entries independent", async () => {
    resolveKey.mockResolvedValue(exaKey);
    vi.stubEnv("TAVILY_API_KEY", tavilyKey);
    let now = 100_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const endpoint = String(input);
      const headers = new Headers(init?.headers);
      if (endpoint === "https://mcp.exa.ai/mcp" && now === 100_000) {
        return json({ error: "rate limited" }, 429, { "Retry-After": "5" });
      }
      if (endpoint === "https://api.tavily.com/extract" && headers.get("X-Tavily-Access-Mode") === "keyless") {
        return json({ error: { code: "KEYLESS_LIMIT", retry_after_seconds: 10 } }, 400);
      }
      return success(endpoint, init);
    });
    vi.stubGlobal("fetch", fetchMock);
    const router = createProviderRouter(await createProviderRegistry()());

    await expect(router.search("query")).resolves.toMatchObject({ provider: "tavily-anon", mode: "anonymous" });
    await expect(router.read(url)).resolves.toMatchObject({ provider: "exa", mode: "keyed" });
    await expect(router.search("query")).resolves.toMatchObject({ provider: "exa", mode: "keyed" });
    expect(fetchMock.mock.calls.map(([endpoint]) => endpoint)).toEqual([
      "https://mcp.exa.ai/mcp",
      "https://api.tavily.com/search",
      "https://api.tavily.com/extract",
      "https://api.exa.ai/contents",
      "https://api.exa.ai/search",
    ]);
    now += 5_000;
    await expect(router.read(url)).resolves.toMatchObject({ provider: "exa-anon", mode: "anonymous" });
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });
});
