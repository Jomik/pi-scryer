import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createProviderRouter,
  ProviderError,
  type ProviderRoute,
  type ReadPage,
  type SearchHit,
  type WebProvider,
} from "../src/provider-routing";

const hit: SearchHit = { title: "Title", url: "https://example.com", snippet: "Excerpt" };
const page: ReadPage = { title: "Title", url: "https://example.com", text: "Content" };

function route(
  search: ProviderRoute["search"] = async () => [hit],
  read: ProviderRoute["read"] = async () => page,
): ProviderRoute {
  return { search, read };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("provider routing", () => {
  it("routes search and read through a third provider with a normalized name", async () => {
    const router = createProviderRouter([{ name: "  third-provider  ", mode: "anonymous", ...route() }]);
    await expect(router.search("q")).resolves.toEqual({
      value: [hit],
      provider: "third-provider",
      mode: "anonymous",
    });
    await expect(router.read(page.url)).resolves.toEqual({
      value: page,
      provider: "third-provider",
      mode: "anonymous",
    });
  });

  it.each(["", " \n\t ", null, undefined, 42])("rejects an invalid provider name at construction: %j", (name) => {
    expect(() => createProviderRouter([{ name: name as string, mode: "anonymous", ...route() }])).toThrow(
      "Web provider name must be a nonempty string",
    );
  });

  it("reports no eligible routes when no providers are configured", async () => {
    await expect(createProviderRouter([]).search("q")).rejects.toThrow("Web providers unavailable: no eligible routes");
  });

  it("reports no eligible routes after all routes are disabled by quota", async () => {
    const search = vi.fn<ProviderRoute["search"]>(async () => {
      throw new ProviderError("quota");
    });
    const router = createProviderRouter([{ name: "exa", mode: "keyed", ...route(search) }]);
    await expect(router.search("q")).rejects.toThrow("Web providers unavailable: exa/keyed: quota");
    await expect(router.search("q")).rejects.toThrow("Web providers unavailable: no eligible routes");
    expect(search).toHaveBeenCalledTimes(1);
  });

  it.each([
    [0, 0, ["exa-anon/anonymous", "tavily-anon/anonymous", "exa/keyed", "tavily/keyed"]],
    [0.99, 0.99, ["tavily-anon/anonymous", "exa-anon/anonymous", "tavily/keyed", "exa/keyed"]],
  ])("randomizes each tier independently and attempts sequentially (%s, %s)", async (anonDraw, keyedDraw, expected) => {
    vi.spyOn(Math, "random").mockReturnValueOnce(anonDraw).mockReturnValueOnce(keyedDraw);
    const calls: string[] = [];
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const failed = (label: string) =>
      route(async () => {
        calls.push(label);
        await pending;
        throw new ProviderError("transient");
      });
    const providers: WebProvider[] = [
      { name: "exa", mode: "keyed", ...failed("exa/keyed") },
      { name: "exa-anon", mode: "anonymous", ...failed("exa-anon/anonymous") },
      { name: "tavily", mode: "keyed", ...failed("tavily/keyed") },
      { name: "tavily-anon", mode: "anonymous", ...failed("tavily-anon/anonymous") },
    ];
    const result = createProviderRouter(providers).search("q");
    expect(calls).toEqual([expected[0]]);
    release();
    await expect(result).rejects.toThrow("Web providers unavailable");
    expect(calls).toEqual(expected);
  });

  it("uses only anonymous routes without configured keys", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    const calls: string[] = [];
    const failed = (name: string) =>
      route(async () => {
        calls.push(name);
        throw new ProviderError("transient");
      });
    const router = createProviderRouter([
      { name: "exa-anon", mode: "anonymous", ...failed("exa-anon/anonymous") },
      { name: "tavily-anon", mode: "anonymous", ...failed("tavily-anon/anonymous") },
    ]);
    await expect(router.search("q")).rejects.toThrow("Web providers unavailable");
    expect(calls).toEqual(["tavily-anon/anonymous", "exa-anon/anonymous"]);
  });

  it("does not start fallback until a pending route fails, and passes the caller signal", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    let failFirst!: (error: Error) => void;
    const first = vi.fn<ProviderRoute["read"]>(
      () =>
        new Promise((_resolve, reject) => {
          failFirst = reject;
        }),
    );
    const second = vi.fn<ProviderRoute["read"]>(async () => page);
    const router = createProviderRouter([
      { name: "exa-anon", mode: "anonymous", ...route(undefined, first) },
      { name: "exa", mode: "keyed", ...route(undefined, second) },
    ]);
    const signal = new AbortController().signal;
    const pending = router.read(page.url, signal);
    expect(first).toHaveBeenCalledWith(page.url, signal);
    expect(second).not.toHaveBeenCalled();
    failFirst(new ProviderError("transient"));
    await expect(pending).resolves.toEqual({ value: page, provider: "exa", mode: "keyed" });
    expect(second).toHaveBeenCalledWith(page.url, signal);
  });

  it("disables quota and invalid-credential routes only, across requests", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const keyed = vi.fn<ProviderRoute["search"]>(async () => {
      throw new ProviderError("quota");
    });
    const anonymous = vi.fn<ProviderRoute["search"]>(async () => {
      throw new ProviderError("invalid-credentials");
    });
    const other = vi.fn<ProviderRoute["search"]>(async () => [hit]);
    const router = createProviderRouter([
      { name: "exa", mode: "keyed", ...route(keyed) },
      { name: "exa-anon", mode: "anonymous", ...route(anonymous) },
      { name: "tavily", mode: "keyed", ...route(other) },
    ]);
    await expect(router.search("q")).resolves.toMatchObject({ provider: "tavily", mode: "keyed" });
    await expect(router.search("q")).resolves.toMatchObject({ provider: "tavily", mode: "keyed" });
    expect(keyed).toHaveBeenCalledTimes(1);
    expect(anonymous).toHaveBeenCalledTimes(1);
    expect(other).toHaveBeenCalledTimes(2);
  });

  it("shares route cooldown across search and read without disabling other routes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    vi.spyOn(Math, "random").mockReturnValue(0);
    const limitedSearch = vi.fn<ProviderRoute["search"]>(async () => {
      throw new ProviderError("rate-limit", 5_000);
    });
    const limitedRead = vi.fn<ProviderRoute["read"]>(async () => page);
    const otherRead = vi.fn<ProviderRoute["read"]>(async () => page);
    const router = createProviderRouter([
      { name: "exa-anon", mode: "anonymous", ...route(limitedSearch, limitedRead) },
      { name: "tavily-anon", mode: "anonymous", ...route(async () => [hit], otherRead) },
    ]);
    await expect(router.search("q")).resolves.toMatchObject({ provider: "tavily-anon" });
    await expect(router.read(page.url)).resolves.toMatchObject({ provider: "tavily-anon" });
    expect(limitedRead).not.toHaveBeenCalled();
    expect(otherRead).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5_000);
    await expect(router.read(page.url)).resolves.toMatchObject({ provider: "exa-anon" });
    expect(limitedRead).toHaveBeenCalledTimes(1);
    expect(limitedSearch).toHaveBeenCalledTimes(1);
  });

  it("skips a rate-limited route until retry-after, then retries it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    vi.spyOn(Math, "random").mockReturnValue(0);
    const keyed = vi
      .fn<ProviderRoute["search"]>()
      .mockRejectedValueOnce(new ProviderError("rate-limit", 5_000))
      .mockResolvedValue([hit]);
    const anonymous = vi.fn<ProviderRoute["search"]>(async () => []);
    const router = createProviderRouter([
      { name: "exa", mode: "keyed", ...route(keyed) },
      { name: "exa-anon", mode: "anonymous", ...route(anonymous) },
    ]);
    await expect(router.search("q")).resolves.toMatchObject({ mode: "anonymous", value: [] });
    await router.search("q");
    expect(keyed).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5_000);
    await expect(router.search("q")).resolves.toMatchObject({ mode: "keyed", value: [hit] });
    expect(keyed).toHaveBeenCalledTimes(2);
  });

  it("uses a fixed cooldown without retry-after and does not persist transient failures", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const limited = vi
      .fn<ProviderRoute["read"]>()
      .mockRejectedValueOnce(new ProviderError("rate-limit"))
      .mockResolvedValue(page);
    const transient = vi
      .fn<ProviderRoute["read"]>()
      .mockRejectedValueOnce(new ProviderError("transient"))
      .mockResolvedValue(page);
    const router = createProviderRouter([
      { name: "exa", mode: "keyed", ...route(undefined, limited) },
      { name: "tavily", mode: "keyed", ...route(undefined, transient) },
    ]);
    vi.spyOn(Math, "random").mockReturnValue(0);
    await expect(router.read(page.url)).rejects.toThrow("rate-limit");
    await expect(router.read(page.url)).resolves.toMatchObject({ provider: "tavily" });
    expect(limited).toHaveBeenCalledTimes(1);
    expect(transient).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(30_000);
    await expect(router.read(page.url)).resolves.toMatchObject({ provider: "exa" });
  });

  it("tries other routes after empty hits; all empty is a valid result even if another route fails", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const empty = vi.fn<ProviderRoute["search"]>(async () => []);
    const router = createProviderRouter([
      { name: "exa", mode: "keyed", ...route(empty) },
      {
        name: "tavily-anon",
        mode: "anonymous",
        ...route(async () => {
          throw new ProviderError("transient");
        }),
      },
    ]);
    await expect(router.search("q")).resolves.toEqual({ value: [], provider: "exa", mode: "keyed" });
    const useful = createProviderRouter([
      { name: "exa", mode: "keyed", ...route(empty) },
      { name: "exa-anon", mode: "anonymous", ...route(async () => [hit]) },
    ]);
    await expect(useful.search("q")).resolves.toEqual({ value: [hit], provider: "exa-anon", mode: "anonymous" });
  });

  it("falls back to another provider when all search hits have malformed URLs", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const malformed = vi.fn<ProviderRoute["search"]>(async () => [
      { url: "file:///tmp/test" },
      { url: "/relative" },
      { url: "not a url" },
      { url: "" },
    ]);
    const valid = vi.fn<ProviderRoute["search"]>(async () => [hit]);
    const router = createProviderRouter([
      { name: "exa", mode: "keyed", ...route(malformed) },
      { name: "tavily", mode: "keyed", ...route(valid) },
    ]);
    await expect(router.search("q")).resolves.toEqual({ value: [hit], provider: "tavily", mode: "keyed" });
    expect(malformed).toHaveBeenCalledTimes(1);
    expect(valid).toHaveBeenCalledTimes(1);
  });

  it("falls back when the first provider has only oversized search URLs", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const oversized = vi.fn<ProviderRoute["search"]>(async () => [
      { url: `  https://example.com/${"a".repeat(2049)}  ` },
    ]);
    const valid = vi.fn<ProviderRoute["search"]>(async () => [hit]);
    const router = createProviderRouter([
      { name: "exa", mode: "keyed", ...route(oversized) },
      { name: "tavily", mode: "keyed", ...route(valid) },
    ]);
    await expect(router.search("q")).resolves.toEqual({ value: [hit], provider: "tavily", mode: "keyed" });
    expect(oversized).toHaveBeenCalledTimes(1);
    expect(valid).toHaveBeenCalledTimes(1);
  });

  it("falls back from an oversized read URL without changing the valid route's page", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const oversized = vi.fn<ProviderRoute["read"]>(async () => ({
      ...page,
      url: `https://example.com/${"a".repeat(2049)}`,
    }));
    const validPage = { ...page, url: `  ${page.url}  `, text: "  Content  " };
    const valid = vi.fn<ProviderRoute["read"]>(async () => validPage);
    const router = createProviderRouter([
      { name: "exa", mode: "keyed", ...route(undefined, oversized) },
      { name: "tavily", mode: "keyed", ...route(undefined, valid) },
    ]);
    await expect(router.read(page.url)).resolves.toEqual({ value: validPage, provider: "tavily", mode: "keyed" });
    expect(oversized).toHaveBeenCalledTimes(1);
    expect(valid).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["empty text", { ...page, text: "  " }],
    ["malformed URL", { ...page, url: "file:///secret" }],
    ["non-string title", { ...page, title: 42 }],
  ])("falls back from a read with %s", async (_label, invalid) => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const first = vi.fn<ProviderRoute["read"]>(async () => invalid as ReadPage);
    const second = vi.fn<ProviderRoute["read"]>(async () => page);
    const router = createProviderRouter([
      { name: "exa-anon", mode: "anonymous", ...route(undefined, first) },
      { name: "exa", mode: "keyed", ...route(undefined, second) },
    ]);
    await expect(router.read(page.url)).resolves.toEqual({ value: page, provider: "exa", mode: "keyed" });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("reports transient read failures without exposing invalid page data", async () => {
    const secret = "file:///secret-page";
    const router = createProviderRouter([
      {
        name: "exa-anon",
        mode: "anonymous",
        ...route(undefined, async () => ({ url: secret, text: "secret-content" })),
      },
    ]);
    await expect(router.read(page.url)).rejects.toThrow("Web providers unavailable: exa-anon/anonymous: transient");
    await expect(router.read(page.url)).rejects.not.toThrow(/secret-page|secret-content/);
  });

  it("does not fall back on cancellation of a read", async () => {
    const controller = new AbortController();
    const first = vi.fn<ProviderRoute["read"]>(async () => {
      controller.abort();
      return { ...page, text: " " };
    });
    const second = vi.fn<ProviderRoute["read"]>(async () => page);
    const router = createProviderRouter([
      { name: "exa-anon", mode: "anonymous", ...route(undefined, first) },
      { name: "exa", mode: "keyed", ...route(undefined, second) },
    ]);
    await expect(router.read(page.url, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(second).not.toHaveBeenCalled();
    await expect(router.read(page.url)).resolves.toMatchObject({ mode: "keyed" });
    expect(first).toHaveBeenCalledTimes(2);
  });

  it("reports a transient failure without exposing malformed search hits when no fallback exists", async () => {
    const router = createProviderRouter([
      { name: "exa-anon", mode: "anonymous", ...route(async () => [{ url: "file:///secret" }]) },
    ]);
    await expect(router.search("q")).rejects.toThrow("Web providers unavailable: exa-anon/anonymous: transient");
    await expect(router.search("q")).rejects.not.toThrow("file:///secret");
  });

  it("propagates cancellation before and during a call without fallback or disabling the route", async () => {
    const controller = new AbortController();
    const keyed = vi.fn<ProviderRoute["search"]>(async () => {
      controller.abort();
      throw new ProviderError("quota");
    });
    const anonymous = vi.fn<ProviderRoute["search"]>(async () => [hit]);
    const router = createProviderRouter([
      { name: "exa-anon", mode: "anonymous", ...route(keyed) },
      { name: "exa", mode: "keyed", ...route(anonymous) },
    ]);
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(router.search("q", alreadyAborted.signal)).rejects.toMatchObject({ name: "AbortError" });
    await expect(router.search("q", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    await expect(router.search("q")).resolves.toMatchObject({ mode: "keyed" });
    expect(keyed).toHaveBeenCalledTimes(2);
    expect(anonymous).toHaveBeenCalledTimes(1);
  });

  it("reports fixed diagnostics without leaking unknown errors or provider response data", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const secret = "secret-token raw-response";
    const router = createProviderRouter([
      {
        name: "exa",
        mode: "keyed",
        ...route(async () => {
          throw new Error(secret);
        }),
      },
      {
        name: "tavily-anon",
        mode: "anonymous",
        ...route(async () => {
          throw new ProviderError("quota");
        }),
      },
    ]);
    await expect(router.search("q")).rejects.toThrow("tavily-anon/anonymous: quota; exa/keyed: unexpected failure");
    await expect(router.search("q")).rejects.not.toThrow(secret);
    await expect(router.search("q")).rejects.toThrow("exa/keyed: unexpected failure");
  });
});
