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
  it.each([
    [0, ["exa/keyed", "exa/anonymous", "tavily/keyed", "tavily/anonymous"]],
    [0.99, ["tavily/keyed", "tavily/anonymous", "exa/keyed", "exa/anonymous"]],
  ])("chooses a provider randomly and tries its routes sequentially (%s)", async (random, expected) => {
    vi.spyOn(Math, "random").mockReturnValue(random as number);
    const calls: string[] = [];
    const failed = (label: string) =>
      route(async () => {
        calls.push(label);
        throw new ProviderError("transient");
      });
    const providers: WebProvider[] = [
      { name: "exa", keyed: failed("exa/keyed"), anonymous: failed("exa/anonymous") },
      {
        name: "tavily",
        keyed: failed("tavily/keyed"),
        anonymous: route(async () => {
          calls.push("tavily/anonymous");
          if (random === 0.99) {
            throw new ProviderError("transient");
          }
          return [hit];
        }),
      },
    ];
    await (random === 0.99
      ? expect(createProviderRouter(providers).search("q")).rejects.toThrow("Web providers unavailable")
      : expect(createProviderRouter(providers).search("q")).resolves.toEqual({
          value: [hit],
          provider: "tavily",
          mode: "anonymous",
        }));
    expect(calls).toEqual(expected);
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
      { name: "exa", keyed: route(undefined, first), anonymous: route(undefined, second) },
    ]);
    const signal = new AbortController().signal;
    const pending = router.read(page.url, signal);
    expect(first).toHaveBeenCalledWith(page.url, signal);
    expect(second).not.toHaveBeenCalled();
    failFirst(new ProviderError("transient"));
    await expect(pending).resolves.toEqual({ value: page, provider: "exa", mode: "anonymous" });
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
      { name: "exa", keyed: route(keyed), anonymous: route(anonymous) },
      { name: "tavily", keyed: route(other) },
    ]);
    await expect(router.search("q")).resolves.toMatchObject({ provider: "tavily", mode: "keyed" });
    await expect(router.search("q")).resolves.toMatchObject({ provider: "tavily", mode: "keyed" });
    expect(keyed).toHaveBeenCalledTimes(1);
    expect(anonymous).toHaveBeenCalledTimes(1);
    expect(other).toHaveBeenCalledTimes(2);
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
    const router = createProviderRouter([{ name: "exa", keyed: route(keyed), anonymous: route(anonymous) }]);
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
      { name: "exa", keyed: route(undefined, limited) },
      { name: "tavily", keyed: route(undefined, transient) },
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
      { name: "exa", keyed: route(empty) },
      {
        name: "tavily",
        anonymous: route(async () => {
          throw new ProviderError("transient");
        }),
      },
    ]);
    await expect(router.search("q")).resolves.toEqual({ value: [], provider: "exa", mode: "keyed" });
    const useful = createProviderRouter([{ name: "exa", keyed: route(empty), anonymous: route(async () => [hit]) }]);
    await expect(useful.search("q")).resolves.toEqual({ value: [hit], provider: "exa", mode: "anonymous" });
  });

  it("propagates cancellation before and during a call without fallback or disabling the route", async () => {
    const controller = new AbortController();
    const keyed = vi.fn<ProviderRoute["search"]>(async () => {
      controller.abort();
      throw new ProviderError("quota");
    });
    const anonymous = vi.fn<ProviderRoute["search"]>(async () => [hit]);
    const router = createProviderRouter([{ name: "exa", keyed: route(keyed), anonymous: route(anonymous) }]);
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(router.search("q", alreadyAborted.signal)).rejects.toMatchObject({ name: "AbortError" });
    await expect(router.search("q", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    await expect(router.search("q")).resolves.toMatchObject({ mode: "anonymous" });
    expect(keyed).toHaveBeenCalledTimes(2);
    expect(anonymous).toHaveBeenCalledTimes(1);
  });

  it("reports fixed diagnostics without leaking unknown errors or provider response data", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const secret = "secret-token raw-response";
    const router = createProviderRouter([
      {
        name: "exa",
        keyed: route(async () => {
          throw new Error(secret);
        }),
      },
      {
        name: "tavily",
        anonymous: route(async () => {
          throw new ProviderError("quota");
        }),
      },
    ]);
    await expect(router.search("q")).rejects.toThrow("exa/keyed: unexpected failure; tavily/anonymous: quota");
    await expect(router.search("q")).rejects.not.toThrow(secret);
    await expect(router.search("q")).rejects.toThrow("exa/keyed: unexpected failure");
  });
});
