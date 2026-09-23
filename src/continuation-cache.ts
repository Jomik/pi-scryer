import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExaContentResult, parseCachedExaContentResult } from "./exa";

const CACHE_DIR_PREFIX = "pi-scryer-";
const CACHE_MAX_ENTRIES = 5;

export interface ContinuationCache {
  readCachedResult(normalizedUrl: string): Promise<ExaContentResult | undefined>;
  writeCachedResult(normalizedUrl: string, result: ExaContentResult): Promise<void>;
  deleteCachedResult(normalizedUrl: string): Promise<void>;
  cleanup(): Promise<void>;
}

/**
 * Per-process disk cache for web_read continuations. Bounded to
 * CACHE_MAX_ENTRIES pages, each backed by a private temp-directory file
 * keyed by a SHA-256 hash of the normalized URL (never the raw URL). Only
 * file path/order metadata is retained in memory between execute calls; no
 * full Exa text is kept resident. All read/write/evict/cleanup operations
 * are serialized through a small promise queue so cleanup and eviction
 * never race an in-flight file operation; network fetches stay outside it.
 */
export function createContinuationCache(): ContinuationCache {
  let cacheDir: string | undefined;
  let cacheDirPromise: Promise<string> | undefined;
  const cacheEntries = new Map<string, { file: string }>();
  let cacheQueue: Promise<void> = Promise.resolve();

  function enqueueCacheTask<T>(task: () => Promise<T>): Promise<T> {
    const run = cacheQueue.then(task, task);
    cacheQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function ensureCacheDir(): Promise<string> {
    if (cacheDir) {
      return cacheDir;
    }
    if (!cacheDirPromise) {
      cacheDirPromise = (async () => {
        let dir: string | undefined;
        try {
          dir = await mkdtemp(join(tmpdir(), CACHE_DIR_PREFIX));
          await chmod(dir, 0o700);
          cacheDir = dir;
          return dir;
        } catch (err) {
          cacheDirPromise = undefined;
          if (dir) {
            await rm(dir, { recursive: true, force: true }).catch(() => {});
          }
          throw err;
        }
      })();
    }
    return cacheDirPromise;
  }

  async function readCachedResult(normalizedUrl: string): Promise<ExaContentResult | undefined> {
    return enqueueCacheTask(async () => {
      const entry = cacheEntries.get(normalizedUrl);
      if (!entry) {
        return undefined;
      }
      try {
        const raw = await readFile(entry.file, "utf-8");
        const parsed: unknown = JSON.parse(raw);
        const normalized = parseCachedExaContentResult(parsed);
        if (!normalized) {
          throw new Error("invalid cache entry");
        }
        // Refresh LRU order on cache hit.
        cacheEntries.delete(normalizedUrl);
        cacheEntries.set(normalizedUrl, entry);
        return normalized;
      } catch {
        cacheEntries.delete(normalizedUrl);
        await rm(entry.file, { force: true }).catch(() => {});
        return undefined;
      }
    });
  }

  async function writeCachedResult(normalizedUrl: string, result: ExaContentResult): Promise<void> {
    await enqueueCacheTask(async () => {
      const dir = await ensureCacheDir();
      const hash = createHash("sha256").update(normalizedUrl).digest("hex");
      const suffix = randomBytes(8).toString("hex");
      const finalPath = join(dir, `${hash}-${suffix}.json`);
      const tmpPath = `${finalPath}.tmp`;
      const payload: ExaContentResult = { title: result.title, url: result.url, text: result.text };
      try {
        await writeFile(tmpPath, JSON.stringify(payload), { mode: 0o600 });
        await rename(tmpPath, finalPath);
      } catch (err) {
        await rm(tmpPath, { force: true }).catch(() => {});
        throw err;
      }

      const previous = cacheEntries.get(normalizedUrl);
      cacheEntries.delete(normalizedUrl);
      cacheEntries.set(normalizedUrl, { file: finalPath });
      if (previous && previous.file !== finalPath) {
        await rm(previous.file, { force: true }).catch(() => {});
      }

      while (cacheEntries.size > CACHE_MAX_ENTRIES) {
        const oldestKey = cacheEntries.keys().next().value;
        if (oldestKey === undefined) {
          break;
        }
        const oldestEntry = cacheEntries.get(oldestKey);
        cacheEntries.delete(oldestKey);
        if (oldestEntry) {
          await rm(oldestEntry.file, { force: true }).catch(() => {});
        }
      }
    });
  }

  async function deleteCachedResult(normalizedUrl: string): Promise<void> {
    await enqueueCacheTask(async () => {
      const entry = cacheEntries.get(normalizedUrl);
      if (!entry) {
        return;
      }
      cacheEntries.delete(normalizedUrl);
      await rm(entry.file, { force: true }).catch(() => {});
    });
  }

  async function cleanup(): Promise<void> {
    await enqueueCacheTask(async () => {
      const dir = cacheDir;
      cacheEntries.clear();
      cacheDir = undefined;
      cacheDirPromise = undefined;
      if (dir) {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    });
  }

  return { readCachedResult, writeCachedResult, deleteCachedResult, cleanup };
}
