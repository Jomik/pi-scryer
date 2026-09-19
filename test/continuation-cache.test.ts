import { readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("misses the cache and re-fetches when continuing a different URL", async () => {
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

    const firstA = await tool.execute(
      "call-1",
      { url: "https://example.com/page-a" },
      new AbortController().signal,
      noop,
      {},
    );
    const detailsA = firstA.details as WebReadToolDetails;
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await tool.execute(
      "call-1",
      { url: "https://example.com/page-b", offset: detailsA.nextOffset },
      new AbortController().signal,
      noop,
      {},
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("starts with an empty cache in a new extension instance and re-fetches", async () => {
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
    await toolB.execute(
      "call-1",
      { url: "https://example.com/page", offset: detailsA.nextOffset },
      new AbortController().signal,
      noop,
      {},
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
    ).rejects.toThrow("web_read: offset is at or beyond the end of the page content");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not poison the cache when an unrelated continuation fetch fails", async () => {
    const tool = getRegisteredTool("web_read");
    const longTextA = Array.from({ length: 5000 }, (_, i) => `a-line ${i}`).join("\n");
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse((init?.body as string) ?? "{}") as { urls: string[] };
      const url = body.urls[0];
      if (url.includes("page-a")) {
        return jsonResponse({ results: [{ title: "Example", url, text: longTextA }] });
      }
      return jsonResponse({ error: "boom" }, 500);
    });
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
    ).rejects.toThrow("request failed with status 500");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const continuedA = await tool.execute(
      "call-1",
      { url: "https://example.com/page-a", offset: detailsA.nextOffset },
      new AbortController().signal,
      noop,
      {},
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
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

    // page-1 was evicted: continuing it must re-fetch.
    await tool.execute(
      "call-1",
      { url: "https://example.com/page-1", offset: nextOffsets.get("https://example.com/page-1") },
      new AbortController().signal,
      noop,
      {},
    );
    expect(fetchMock).toHaveBeenCalledTimes(7);
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
    // deleted; continuing it again must re-fetch, while page B stays cached.
    await tool.execute(
      "call-1",
      { url: "https://example.com/page-a", offset: 1 },
      new AbortController().signal,
      noop,
      {},
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("falls back to Exa and re-fetches when the cached file is deleted from disk", async () => {
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

    await tool.execute(
      "call-1",
      { url: "https://example.com/page", offset: details.nextOffset },
      new AbortController().signal,
      noop,
      {},
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to Exa and re-fetches when the cached file is corrupted", async () => {
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

    await tool.execute(
      "call-1",
      { url: "https://example.com/page", offset: details.nextOffset },
      new AbortController().signal,
      noop,
      {},
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
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

    // Continuing after shutdown finds no disk entry, re-fetches, and lazily
    // creates a fresh cache directory.
    await tool.execute(
      "call-1",
      { url: "https://example.com/page", offset: details.nextOffset },
      new AbortController().signal,
      noop,
      {},
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const afterSecondFetch = await listCacheDirNames();
    const newDirs = afterSecondFetch.filter((name) => name !== createdDirs[0]);
    expect(newDirs.length).toBeGreaterThan(0);
  });

  it("returns a valid chunk when cache initialization fails, then re-fetches and successfully caches once the environment is restored, leaving no .tmp files", async () => {
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

      // No cache entry exists (write failed), so this must re-fetch rather
      // than reuse a permanently rejected cache-dir promise.
      const second = await tool.execute(
        "call-1",
        { url: "https://example.com/page", offset: details.nextOffset },
        new AbortController().signal,
        noop,
        {},
      );
      const detailsSecond = second.details as WebReadToolDetails;
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(detailsSecond.truncated).toBe(true);

      // The environment is restored, so this fetch's result should now be
      // cached successfully; the next continuation must hit the cache.
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

  it("treats a cached file with valid JSON but invalid metadata (non-http/oversized URL, newline/oversized title) as a cache miss and returns freshly normalized metadata", async () => {
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

    const second = await tool.execute(
      "call-1",
      { url: "https://example.com/page", offset: details.nextOffset },
      new AbortController().signal,
      noop,
      {},
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const detailsSecond = second.details as WebReadToolDetails;
    expect(detailsSecond.title).toBe("Example");
    expect(second.content[0].text).not.toContain("stale cached text");

    // The corrupt cache file was removed rather than left behind.
    await expect(stat(filePath)).rejects.toThrow();
  });
});
