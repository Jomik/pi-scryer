import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { CACHE_DIR_PREFIX, listCacheDirNames } from "./harness";

it("uses a private temporary root and ignores foreign global cache directories", async () => {
  const root = tmpdir();
  expect(basename(root)).toMatch(/^scryer-test-/);
  expect(process.env.TMPDIR).toBe(root);
  expect((await stat(root)).mode & 0o777).toBe(0o700);

  const foreign = await mkdtemp(join(dirname(root), CACHE_DIR_PREFIX));
  const local = await mkdtemp(join(root, CACHE_DIR_PREFIX));
  try {
    expect(await listCacheDirNames()).toContain(basename(local));
    expect(await listCacheDirNames()).not.toContain(basename(foreign));

    vi.stubEnv("TMPDIR", join(root, "invalid"));
    vi.unstubAllEnvs();
    expect(tmpdir()).toBe(root);
  } finally {
    vi.unstubAllEnvs();
    await rm(local, { recursive: true, force: true });
    await rm(foreign, { recursive: true, force: true });
  }
});
