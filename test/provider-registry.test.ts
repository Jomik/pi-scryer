import { afterEach, describe, expect, it, vi } from "vitest";
import { createProviderRegistry } from "../src/providers/registry";

const resolveKey = vi.hoisted(() => vi.fn<() => Promise<string | undefined>>());
vi.mock("../src/credentials", () => ({ resolveExaApiKey: resolveKey }));

afterEach(() => {
  resolveKey.mockReset();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("provider registry", () => {
  it("loads credentials lazily and preserves provider order and anonymous routes", async () => {
    resolveKey.mockResolvedValue(undefined);
    vi.stubEnv("TAVILY_API_KEY", "");
    const loadProviders = createProviderRegistry();
    expect(resolveKey).not.toHaveBeenCalled();

    const providers = await loadProviders();
    expect(resolveKey).toHaveBeenCalledTimes(1);
    expect(providers.map((provider) => provider.name)).toEqual(["exa", "tavily"]);
    for (const provider of providers) {
      expect(provider.keyed).toBeUndefined();
      expect(provider.anonymous).toMatchObject({ search: expect.any(Function), read: expect.any(Function) });
    }
  });

  it("attaches the optional keyed Exa route", async () => {
    resolveKey.mockResolvedValue("test-exa-key");
    const [exa] = await createProviderRegistry()();
    expect(exa.keyed).toMatchObject({ search: expect.any(Function), read: expect.any(Function) });
    expect(exa.anonymous).toMatchObject({ search: expect.any(Function), read: expect.any(Function) });
  });

  it("captures Tavily's environment key at factory creation, not loading", async () => {
    resolveKey.mockResolvedValue(undefined);
    vi.stubEnv("TAVILY_API_KEY", "  activation-key  ");
    const loadProviders = createProviderRegistry();
    vi.stubEnv("TAVILY_API_KEY", "later-key");
    const [, tavily] = await loadProviders();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ results: [] }), { headers: { "content-type": "application/json" } }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await tavily.keyed?.search("query");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("Authorization")).toBe("Bearer activation-key");
  });
});
