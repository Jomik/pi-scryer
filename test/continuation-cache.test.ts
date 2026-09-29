import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createContinuationCache } from "../src/continuation-cache";
import type { AccessMode, ProviderName } from "../src/provider-routing";
import {
  getRegisteredTool,
  getRegisteredToolWithShutdown,
  jsonResponse,
  listCacheDirNames,
  noop,
  ORIGINAL_ENV,
  SECRET_KEY,
  type WebReadToolDetails,
} from "./harness";

describe("web_read extension", () => {
  beforeEach(() => {
    process.env.EXA_API_KEY = SECRET_KEY;
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.EXA_API_KEY;
    } else {
      process.env.EXA_API_KEY = ORIGINAL_ENV;
    }
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("continues a long page via the exact returned nextOffset using the cache, without re-fetching", async () => {
    const tool = getRegisteredTool("web_read");
    const longText = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        results: [{ title: "Example", url: "https://resolved.example/page", text: longText }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const chunks: WebReadToolDetails[] = [];
    let offset: number | undefined;
    for (let iterations = 0; ; iterations++) {
      if (iterations > 20) {
        throw new Error("too many iterations");
      }
      const params: Record<string, unknown> = { url: "https://example.com/page" };
      if (offset !== undefined) {
        params.offset = offset;
      }
      const result = await tool.execute("call-1", params, new AbortController().signal, noop, {});
      const details = result.details as WebReadToolDetails;
      chunks.push(details);
      if (!details.truncated) {
        break;
      }
      offset = details.nextOffset;
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[chunks.length - 1].truncated).toBe(false);
    expect(chunks[chunks.length - 1].nextOffset).toBeUndefined();

    let expectedOffset = 0;
    for (const details of chunks) {
      expect(details.offset).toBe(expectedOffset);
      expect(details.totalLength).toBe(longText.length);
      expectedOffset = details.nextOffset ?? longText.length;
    }
    expect(expectedOffset).toBe(longText.length);
  });

  it("re-fetches fresh content whenever offset is omitted or 0, even with a matching cache", async () => {
    const tool = getRegisteredTool("web_read");
    const longText = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ results: [{ title: "Example", url: "https://resolved.example/page", text: longText }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = await tool.execute(
      "call-1",
      { url: "https://example.com/page" },
      new AbortController().signal,
      noop,
      {},
    );
    expect((first.details as WebReadToolDetails).truncated).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await tool.execute(
      "call-1",
      { url: "https://example.com/page", offset: 0 },
      new AbortController().signal,
      noop,
      {},
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await tool.execute("call-1", { url: "https://example.com/page" }, new AbortController().signal, noop, {});
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("rejects a continuation for a different URL without fetching", async () => {
    const tool = getRegisteredTool("web_read");
    const longTextA = Array.from({ length: 5000 }, (_, i) => `a-line ${i}`).join("\n");
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ results: [{ title: "Example", url: "https://example.com/page-a", text: longTextA }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const firstA = await tool.execute(
      "call-1",
      { url: "https://example.com/page-a" },
      new AbortController().signal,
      noop,
      {},
    );
    const detailsA = firstA.details as WebReadToolDetails;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(
      tool.execute(
        "call-1",
        { url: "https://example.com/page-b", offset: detailsA.nextOffset },
        new AbortController().signal,
        noop,
        {},
      ),
    ).rejects.toThrow("web_read: continuation expired; restart with offset 0");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a continuation in a new extension instance without fetching", async () => {
    const longText = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ results: [{ title: "Example", url: "https://resolved.example/page", text: longText }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const toolA = getRegisteredTool("web_read");
    const firstA = await toolA.execute(
      "call-1",
      { url: "https://example.com/page" },
      new AbortController().signal,
      noop,
      {},
    );
    const detailsA = firstA.details as WebReadToolDetails;
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const toolB = getRegisteredTool("web_read");
    await expect(
      toolB.execute(
        "call-1",
        { url: "https://example.com/page", offset: detailsA.nextOffset },
        new AbortController().signal,
        noop,
        {},
      ),
    ).rejects.toThrow("web_read: continuation expired; restart with offset 0");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps two different long pages independently continuable without re-fetching, even after concurrent initial reads", async () => {
    const tool = getRegisteredTool("web_read");
    const longTextA = Array.from({ length: 5000 }, (_, i) => `a-line ${i}`).join("\n");
    const longTextB = Array.from({ length: 5000 }, (_, i) => `b-line ${i}`).join("\n");
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse((init?.body as string) ?? "{}") as { urls: string[] };
      const url = body.urls[0];
      const text = url.includes("page-a") ? longTextA : longTextB;
      return jsonResponse({ results: [{ title: "Example", url, text }] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const [firstA, firstB] = await Promise.all([
      tool.execute("call-1", { url: "https://example.com/page-a" }, new AbortController().signal, noop, {}),
      tool.execute("call-1", { url: "https://example.com/page-b" }, new AbortController().signal, noop, {}),
    ]);
    const detailsA = firstA.details as WebReadToolDetails;
    const detailsB = firstB.details as WebReadToolDetails;
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await tool.execute(
      "call-1",
      { url: "https://example.com/page-a", offset: detailsA.nextOffset },
      new AbortController().signal,
      noop,
      {},
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await tool.execute(
      "call-1",
      { url: "https://example.com/page-b", offset: detailsB.nextOffset },
      new AbortController().signal,
      noop,
      {},
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not cache a short, complete read", async () => {
    const tool = getRegisteredTool("web_read");
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ results: [{ title: "Example", url: "https://resolved.example/page", text: "short text" }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await tool.execute(
      "call-1",
      { url: "https://example.com/page" },
      new AbortController().signal,
      noop,
      {},
    );
    const details = result.details as WebReadToolDetails;
    expect(details.truncated).toBe(false);
    expect(details.nextOffset).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await expect(
      tool.execute("call-1", { url: "https://example.com/page", offset: 100 }, new AbortController().signal, noop, {}),
    ).rejects.toThrow("web_read: continuation expired; restart with offset 0");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not poison the cache when an unrelated continuation is missing", async () => {
    const tool = getRegisteredTool("web_read");
    const longTextA = Array.from({ length: 5000 }, (_, i) => `a-line ${i}`).join("\n");
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ results: [{ title: "Example", url: "https://example.com/page-a", text: longTextA }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const firstA = await tool.execute(
      "call-1",
      { url: "https://example.com/page-a" },
      new AbortController().signal,
      noop,
      {},
    );
    const detailsA = firstA.details as WebReadToolDetails;
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await expect(
      tool.execute(
        "call-1",
        { url: "https://example.com/page-failing", offset: detailsA.nextOffset },
        new AbortController().signal,
        noop,
        {},
      ),
    ).rejects.toThrow("web_read: continuation expired; restart with offset 0");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const continuedA = await tool.execute(
      "call-1",
      { url: "https://example.com/page-a", offset: detailsA.nextOffset },
      new AbortController().signal,
      noop,
      {},
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((continuedA.details as WebReadToolDetails).offset).toBe(detailsA.nextOffset);
  });

  it("evicts the least-recently-used cached page when a sixth long page is cached, and refreshes entries accessed first", async () => {
    const tool = getRegisteredTool("web_read");
    const pageText = (label: string) => Array.from({ length: 5000 }, (_, i) => `${label}-line ${i}`).join("\n");
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse((init?.body as string) ?? "{}") as { urls: string[] };
      const url = body.urls[0];
      const label = url.match(/page-(\d+)/)?.[1] ?? "x";
      return jsonResponse({ results: [{ title: "Example", url, text: pageText(label) }] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const nextOffsets = new Map<string, number>();
    for (let i = 0; i < 5; i++) {
      const url = `https://example.com/page-${i}`;
      const result = await tool.execute("call-1", { url }, new AbortController().signal, noop, {});
      nextOffsets.set(url, (result.details as WebReadToolDetails).nextOffset as number);
    }
    expect(fetchMock).toHaveBeenCalledTimes(5);

    // Access page-0's continuation before inserting a sixth page: this is a
    // cache hit (no extra fetch) that must refresh its LRU position.
    await tool.execute(
      "call-1",
      { url: "https://example.com/page-0", offset: nextOffsets.get("https://example.com/page-0") },
      new AbortController().signal,
      noop,
      {},
    );
    expect(fetchMock).toHaveBeenCalledTimes(5);

    // Insert a sixth page: this must evict the least-recently-used entry,
    // which is page-1 (page-0 was just refreshed ahead of it).
    const sixthUrl = "https://example.com/page-5";
    const sixth = await tool.execute("call-1", { url: sixthUrl }, new AbortController().signal, noop, {});
    nextOffsets.set(sixthUrl, (sixth.details as WebReadToolDetails).nextOffset as number);
    expect(fetchMock).toHaveBeenCalledTimes(6);

    // The other five entries remain cached and do not trigger extra fetches.
    // Checked before touching page-1 below, since re-caching an evicted entry
    // would itself evict another (now-oldest) entry as a side effect.
    for (const url of [
      "https://example.com/page-0",
      "https://example.com/page-2",
      "https://example.com/page-3",
      "https://example.com/page-4",
      sixthUrl,
    ]) {
      await tool.execute("call-1", { url, offset: nextOffsets.get(url) }, new AbortController().signal, noop, {});
    }
    expect(fetchMock).toHaveBeenCalledTimes(6);

    // page-1 was evicted: continuing it must request a restart, without fetching.
    await expect(
      tool.execute(
        "call-1",
        { url: "https://example.com/page-1", offset: nextOffsets.get("https://example.com/page-1") },
        new AbortController().signal,
        noop,
        {},
      ),
    ).rejects.toThrow("web_read: continuation expired; restart with offset 0");
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("deletes only the finished URL's cache entry on the final chunk, leaving another cached page usable", async () => {
    const tool = getRegisteredTool("web_read");
    const longTextA = Array.from({ length: 5000 }, (_, i) => `a-line ${i}`).join("\n");
    const longTextB = Array.from({ length: 5000 }, (_, i) => `b-line ${i}`).join("\n");
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse((init?.body as string) ?? "{}") as { urls: string[] };
      const url = body.urls[0];
      const text = url.includes("page-a") ? longTextA : longTextB;
      return jsonResponse({ results: [{ title: "Example", url, text }] });
    });
    vi.stubGlobal("fetch", fetchMock);

    let offsetA: number | undefined;
    let truncatedA = true;
    for (let iterations = 0; truncatedA; iterations++) {
      if (iterations > 20) {
        throw new Error("too many iterations");
      }
      const params: Record<string, unknown> = { url: "https://example.com/page-a" };
      if (offsetA !== undefined) {
        params.offset = offsetA;
      }
      const result = await tool.execute("call-1", params, new AbortController().signal, noop, {});
      const details = result.details as WebReadToolDetails;
      truncatedA = details.truncated;
      offsetA = details.nextOffset;
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const firstB = await tool.execute(
      "call-1",
      { url: "https://example.com/page-b" },
      new AbortController().signal,
      noop,
      {},
    );
    const detailsB = firstB.details as WebReadToolDetails;
    expect(detailsB.truncated).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await tool.execute(
      "call-1",
      { url: "https://example.com/page-b", offset: detailsB.nextOffset },
      new AbortController().signal,
      noop,
      {},
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Page A finished on its final chunk above, so its cache entry was
    // deleted; continuing it again must request a restart, while page B stays cached.
    await expect(
      tool.execute("call-1", { url: "https://example.com/page-a", offset: 1 }, new AbortController().signal, noop, {}),
    ).rejects.toThrow("web_read: continuation expired; restart with offset 0");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("requests a restart without fetching when the cached file is deleted from disk", async () => {
    const before = await listCacheDirNames();
    const tool = getRegisteredTool("web_read");
    const longText = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ results: [{ title: "Example", url: "https://resolved.example/page", text: longText }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = await tool.execute(
      "call-1",
      { url: "https://example.com/page" },
      new AbortController().signal,
      noop,
      {},
    );
    const details = first.details as WebReadToolDetails;
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const after = await listCacheDirNames();
    const newDirs = after.filter((name) => !before.includes(name));
    expect(newDirs.length).toBe(1);
    const cacheDirPath = join(tmpdir(), newDirs[0]);
    const files = (await readdir(cacheDirPath)).filter((name) => name.endsWith(".json"));
    expect(files.length).toBe(1);
    await rm(join(cacheDirPath, files[0]), { force: true });

    await expect(
      tool.execute(
        "call-1",
        { url: "https://example.com/page", offset: details.nextOffset },
        new AbortController().signal,
        noop,
        {},
      ),
    ).rejects.toThrow("web_read: continuation expired; restart with offset 0");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await readdir(cacheDirPath)).filter((name) => name.endsWith(".json"))).toHaveLength(0);
  });

  it("requests a restart without fetching when the cached file is corrupted", async () => {
    const before = await listCacheDirNames();
    const tool = getRegisteredTool("web_read");
    const longText = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ results: [{ title: "Example", url: "https://resolved.example/page", text: longText }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = await tool.execute(
      "call-1",
      { url: "https://example.com/page" },
      new AbortController().signal,
      noop,
      {},
    );
    const details = first.details as WebReadToolDetails;
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const after = await listCacheDirNames();
    const newDirs = after.filter((name) => !before.includes(name));
    expect(newDirs.length).toBe(1);
    const cacheDirPath = join(tmpdir(), newDirs[0]);
    const files = (await readdir(cacheDirPath)).filter((name) => name.endsWith(".json"));
    expect(files.length).toBe(1);
    await writeFile(join(cacheDirPath, files[0]), "not valid json{");

    await expect(
      tool.execute(
        "call-1",
        { url: "https://example.com/page", offset: details.nextOffset },
        new AbortController().signal,
        noop,
        {},
      ),
    ).rejects.toThrow("web_read: continuation expired; restart with offset 0");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(stat(join(cacheDirPath, files[0]))).rejects.toThrow();
  });

  it("lazily creates a private per-process cache directory and files with the expected shape", async () => {
    const before = await listCacheDirNames();
    const tool = getRegisteredTool("web_read");
    const urls = Array.from({ length: 6 }, (_, i) => `https://example.com/page-${i}`);
    const textFor = (i: number) => Array.from({ length: 5000 }, (_, j) => `p${i}-line ${j}`).join("\n");
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse((init?.body as string) ?? "{}") as { urls: string[] };
      const url = body.urls[0];
      const idx = Number(url.match(/page-(\d+)/)?.[1] ?? "0");
      return jsonResponse({ results: [{ title: "Example", url, text: textFor(idx) }] });
    });
    vi.stubGlobal("fetch", fetchMock);

    for (const url of urls) {
      await tool.execute("call-1", { url }, new AbortController().signal, noop, {});
    }

    const after = await listCacheDirNames();
    const newDirs = after.filter((name) => !before.includes(name));
    expect(newDirs.length).toBe(1);
    const cacheDirPath = join(tmpdir(), newDirs[0]);

    const dirStat = await stat(cacheDirPath);
    expect(dirStat.mode & 0o777).toBe(0o700);

    const entries = await readdir(cacheDirPath);
    expect(entries.filter((name) => name.endsWith(".tmp")).length).toBe(0);

    const jsonFiles = entries.filter((name) => name.endsWith(".json"));
    expect(jsonFiles.length).toBe(5);

    for (const file of jsonFiles) {
      for (const url of urls) {
        expect(file).not.toContain(url);
      }
      expect(file).not.toContain("example.com");
      expect(file).not.toContain("page-");
      const fileStat = await stat(join(cacheDirPath, file));
      expect(fileStat.mode & 0o777).toBe(0o600);
    }
  });

  it("recursively removes the cache directory on session_shutdown and lazily recreates it afterward", async () => {
    const before = await listCacheDirNames();
    const { tool, shutdown } = getRegisteredToolWithShutdown("web_read");
    const longText = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ results: [{ title: "Example", url: "https://resolved.example/page", text: longText }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = await tool.execute(
      "call-1",
      { url: "https://example.com/page" },
      new AbortController().signal,
      noop,
      {},
    );
    const details = first.details as WebReadToolDetails;
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const afterFirstFetch = await listCacheDirNames();
    const createdDirs = afterFirstFetch.filter((name) => !before.includes(name));
    expect(createdDirs.length).toBe(1);
    const cacheDirPath = join(tmpdir(), createdDirs[0]);
    await expect(stat(cacheDirPath)).resolves.toBeDefined();

    await shutdown();

    await expect(stat(cacheDirPath)).rejects.toThrow();

    // Continuing after shutdown cannot create a new cache or fetch; a fresh
    // offset-0 read recreates the cache directory.
    await expect(
      tool.execute(
        "call-1",
        { url: "https://example.com/page", offset: details.nextOffset },
        new AbortController().signal,
        noop,
        {},
      ),
    ).rejects.toThrow("web_read: continuation expired; restart with offset 0");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await listCacheDirNames()).filter((name) => !before.includes(name))).toHaveLength(0);

    await tool.execute(
      "call-1",
      { url: "https://example.com/page", offset: 0 },
      new AbortController().signal,
      noop,
      {},
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((await listCacheDirNames()).filter((name) => !before.includes(name))).toHaveLength(1);
  });

  it("returns a valid chunk when cache initialization fails, then requires an offset-0 restart to cache after recovery", async () => {
    const originalTmpdir = process.env.TMPDIR;
    const invalidTmpdir = join(
      tmpdir(),
      `pi-scryer-invalid-tmpdir-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    try {
      process.env.TMPDIR = invalidTmpdir;

      const tool = getRegisteredTool("web_read");
      const longText = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
      const fetchMock = vi.fn<typeof fetch>(async () =>
        jsonResponse({
          results: [{ title: "Example", url: "https://resolved.example/page", text: longText }],
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      // Cache initialization fails (invalid TMPDIR), but the read itself must
      // still succeed with a valid chunk/nextOffset; the failed cache write is
      // swallowed as best-effort.
      const first = await tool.execute(
        "call-1",
        { url: "https://example.com/page" },
        new AbortController().signal,
        noop,
        {},
      );
      const details = first.details as WebReadToolDetails;
      expect(details.truncated).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      if (originalTmpdir === undefined) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = originalTmpdir;
      }

      // The failed write left no cache entry; continuation cannot re-fetch.
      await expect(
        tool.execute(
          "call-1",
          { url: "https://example.com/page", offset: details.nextOffset },
          new AbortController().signal,
          noop,
          {},
        ),
      ).rejects.toThrow("web_read: continuation expired; restart with offset 0");
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // A fresh offset-0 read can now cache the result after recovery.
      const second = await tool.execute(
        "call-1",
        { url: "https://example.com/page", offset: 0 },
        new AbortController().signal,
        noop,
        {},
      );
      const detailsSecond = second.details as WebReadToolDetails;
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(detailsSecond.truncated).toBe(true);

      // The next continuation must hit the cache.
      await tool.execute(
        "call-1",
        { url: "https://example.com/page", offset: detailsSecond.nextOffset },
        new AbortController().signal,
        noop,
        {},
      );
      expect(fetchMock).toHaveBeenCalledTimes(2);

      const dirs = await listCacheDirNames();
      for (const name of dirs) {
        const entries = await readdir(join(tmpdir(), name));
        expect(entries.filter((entry) => entry.endsWith(".tmp")).length).toBe(0);
      }
    } finally {
      if (originalTmpdir === undefined) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = originalTmpdir;
      }
    }
  });

  it("rejects a cached file with valid JSON but invalid metadata without fetching", async () => {
    const before = await listCacheDirNames();
    const tool = getRegisteredTool("web_read");
    const longText = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        results: [{ title: "Example", url: "https://resolved.example/page", text: longText }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = await tool.execute(
      "call-1",
      { url: "https://example.com/page" },
      new AbortController().signal,
      noop,
      {},
    );
    const details = first.details as WebReadToolDetails;
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const after = await listCacheDirNames();
    const newDirs = after.filter((name) => !before.includes(name));
    expect(newDirs.length).toBe(1);
    const cacheDirPath = join(tmpdir(), newDirs[0]);
    const files = (await readdir(cacheDirPath)).filter((name) => name.endsWith(".json"));
    expect(files.length).toBe(1);
    const filePath = join(cacheDirPath, files[0]);

    // Valid JSON, but invalid metadata: non-http URL and an oversized,
    // multi-line title.
    const invalidPayload = JSON.stringify({
      title: `Bad\nTitle ${"x".repeat(5000)}`,
      url: "ftp://not-http.example/page",
      text: "stale cached text",
    });
    await writeFile(filePath, invalidPayload);

    await expect(
      tool.execute(
        "call-1",
        { url: "https://example.com/page", offset: details.nextOffset },
        new AbortController().signal,
        noop,
        {},
      ),
    ).rejects.toThrow("web_read: continuation expired; restart with offset 0");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The corrupt cache file was removed rather than left behind.
    await expect(stat(filePath)).rejects.toThrow();
  });
});

describe("continuation cache attribution", () => {
  const url = "https://example.com/page";
  const page = { title: "Example", url, text: "Full page text" };

  async function cachedFile(before: string[]): Promise<string> {
    const dirs = (await listCacheDirNames()).filter((name) => !before.includes(name));
    expect(dirs).toHaveLength(1);
    const files = (await readdir(join(tmpdir(), dirs[0]))).filter((name) => name.endsWith(".json"));
    expect(files).toHaveLength(1);
    return join(tmpdir(), dirs[0], files[0]);
  }

  it.each([
    ["exa", "keyed"],
    ["exa", "anonymous"],
    ["tavily", "keyed"],
    ["tavily", "anonymous"],
  ] as const)("round-trips %s/%s attribution through the private disk file", async (provider, mode) => {
    const before = await listCacheDirNames();
    const cache = createContinuationCache();
    try {
      const result = { ...page, provider, mode };
      await cache.writeCachedResult(url, result);
      const file = await cachedFile(before);
      expect(JSON.parse(await readFile(file, "utf-8"))).toEqual(result);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect(await cache.readCachedResult(url)).toEqual(result);
    } finally {
      await cache.cleanup();
    }
  });

  it("keeps legacy and GitHub entries without attribution valid", async () => {
    const before = await listCacheDirNames();
    const cache = createContinuationCache();
    try {
      await cache.writeCachedResult(url, page);
      const file = await cachedFile(before);
      expect(JSON.parse(await readFile(file, "utf-8"))).toEqual(page);
      expect(await cache.readCachedResult(url)).toEqual(page);
    } finally {
      await cache.cleanup();
    }
  });

  it.each([
    { provider: "other", mode: "keyed" },
    { provider: "exa", mode: "other" },
    { provider: "exa" },
    { mode: "anonymous" },
    { provider: null, mode: "keyed" },
    { provider: "exa", mode: null },
  ])("removes a cache file with invalid or partial attribution: %j", async (metadata) => {
    const before = await listCacheDirNames();
    const cache = createContinuationCache();
    try {
      await cache.writeCachedResult(url, page);
      const file = await cachedFile(before);
      await writeFile(file, JSON.stringify({ ...page, ...metadata }));
      expect(await cache.readCachedResult(url)).toBeUndefined();
      await expect(stat(file)).rejects.toThrow();
      expect(await cache.readCachedResult(url)).toBeUndefined();
    } finally {
      await cache.cleanup();
    }
  });

  it("does not write partial or invalid attribution", async () => {
    const cache = createContinuationCache();
    try {
      for (const metadata of [{ provider: "exa" }, { mode: "keyed" }, { provider: "exa", mode: "invalid" }]) {
        await expect(
          cache.writeCachedResult(url, { ...page, ...metadata } as typeof page & {
            provider: ProviderName;
            mode: AccessMode;
          }),
        ).rejects.toThrow("invalid cache attribution");
      }
      expect(await cache.readCachedResult(url)).toBeUndefined();
    } finally {
      await cache.cleanup();
    }
  });
});
