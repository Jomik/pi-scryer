import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { CACHE_DIR_PREFIX, execFileMock, listCacheDirNames } from "./harness";
import { consumeBoundaryAttempts } from "./setup";

it.each(["exa-api-key", "tavily-api-key"])("fakes only registered Keychain find shapes for %s", (account) => {
  for (const suffix of [[], ["-w"]]) {
    const callback = vi.fn();
    execFileMock("security", ["find-generic-password", "-s", "pi-scryer", "-a", account, ...suffix], callback);
    expect(callback).toHaveBeenCalledWith(expect.any(Error), "", expect.stringContaining("could not be found"));
  }
  expect(consumeBoundaryAttempts()).toEqual([]);
});

it.each([
  ["osascript", ["-e", "test-only-script"]],
  ["security", ["add-generic-password", "-s", "pi-scryer", "-a", "exa-api-key"]],
  ["security", ["delete-generic-password", "-s", "pi-scryer", "-a", "exa-api-key"]],
  ["security", ["find-generic-password", "-s", "other-service", "-a", "exa-api-key", "-w"]],
  ["security", ["find-generic-password", "-s", "pi-scryer", "-a", "unknown-account", "-w"]],
  ["security", ["find-generic-password", "-s", "pi-scryer", "-a", "exa-api-key", "-w", "extra"]],
  ["gh", ["auth", "login"]],
  ["git", ["fetch"]],
] as const)("rejects unregistered harness command fixture %s", (file, args) => {
  const callback = vi.fn();
  expect(() => execFileMock(file, args, callback)).toThrow("Unexpected external boundary: child_process.execFile");
  expect(callback).not.toHaveBeenCalled();
  expect(consumeBoundaryAttempts()).toEqual(["child_process.execFile"]);
});

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
