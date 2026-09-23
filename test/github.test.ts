import { mkdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitHubReader } from "../src/github";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;
type ExecFileCall = [string, string[], Record<string, unknown>, ExecFileCallback];

const PARENT_DIR = "/tmp/pi-scryer";

function calls(): ExecFileCall[] {
  return execFileMock.mock.calls as unknown as ExecFileCall[];
}

/** Directory arg used by our clone/checkout call shapes. */
function dirArgOf(args: string[], options: Record<string, unknown>): string {
  return (options.cwd as string | undefined) ?? args[args.length - 1];
}

const createdDirs = new Set<string>();

/** Standard mock: succeeds for every git invocation. ls-remote returns the
 * given ref names as heads. Clone calls create `fixture` entries under the
 * target directory so the reader has real files/directories to read. */
function mockGitSuccess(options: { refs?: string[]; fixture?: (dir: string) => Promise<void> } = {}) {
  const refs = options.refs ?? [];
  execFileMock.mockImplementation(
    async (_file: string, args: string[], opts: Record<string, unknown>, callback: ExecFileCallback) => {
      const dir = dirArgOf(args, opts);
      createdDirs.add(dir);
      if (args[0] === "ls-remote") {
        const stdout = refs.map((name) => `abc123\trefs/heads/${name}`).join("\n");
        callback(null, stdout, "");
        return;
      }
      if (args[0] === "clone" && options.fixture) {
        await options.fixture(dir);
      }
      callback(null, "", "");
    },
  );
}

async function cleanupCreatedDirs(): Promise<void> {
  for (const dir of createdDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  createdDirs.clear();
}

describe("github reader", () => {
  afterEach(async () => {
    execFileMock.mockReset();
    await cleanupCreatedDirs();
  });

  it("throws (never undefined) for non-repo GitHub URLs without invoking git, to protect private data", async () => {
    const reader = createGitHubReader();
    await expect(
      reader.read("https://github.com/octocat/hello-world/issues/42", new AbortController().signal),
    ).rejects.toThrow("github: unsupported GitHub URL");
    expect(execFileMock).not.toHaveBeenCalled();
    await reader.cleanup();
  });

  it("throws for github.com subdomains and githubusercontent.com hosts without invoking git", async () => {
    const reader = createGitHubReader();
    await expect(reader.read("https://gist.github.com/octocat/abc123", new AbortController().signal)).rejects.toThrow(
      "github: unsupported GitHub URL",
    );
    await expect(
      reader.read("https://raw.githubusercontent.com/octocat/hello-world/main/README.md", new AbortController().signal),
    ).rejects.toThrow("github: unsupported GitHub URL");
    await expect(
      reader.read("https://githubusercontent.com/octocat/hello-world", new AbortController().signal),
    ).rejects.toThrow("github: unsupported GitHub URL");
    expect(execFileMock).not.toHaveBeenCalled();
    await reader.cleanup();
  });

  it("does not treat lookalike domains as GitHub-owned", async () => {
    const reader = createGitHubReader();
    const result = await reader.read(
      "https://github.com.evil.example/octocat/hello-world",
      new AbortController().signal,
    );
    expect(result).toBeUndefined();
    expect(execFileMock).not.toHaveBeenCalled();
    await reader.cleanup();
  });

  it("returns undefined for non-GitHub URLs without invoking git", async () => {
    const reader = createGitHubReader();
    const result = await reader.read("https://example.com/owner/repo", new AbortController().signal);
    expect(result).toBeUndefined();
    expect(execFileMock).not.toHaveBeenCalled();
    await reader.cleanup();
  });

  it("throws (never undefined) for malformed owner/repo on a github.com URL", async () => {
    const reader = createGitHubReader();
    await expect(reader.read("https://github.com/bad..owner/repo", new AbortController().signal)).rejects.toThrow(
      "github: malformed owner or repository name",
    );
    expect(execFileMock).not.toHaveBeenCalled();
    await reader.cleanup();
  });

  it("throws for URL credentials and non-default ports instead of returning undefined", async () => {
    const reader = createGitHubReader();
    await expect(
      reader.read("https://user:pass@github.com/octocat/hello-world", new AbortController().signal),
    ).rejects.toThrow("credentials");
    await expect(
      reader.read("https://github.com:8443/octocat/hello-world", new AbortController().signal),
    ).rejects.toThrow("custom port");
    expect(execFileMock).not.toHaveBeenCalled();
    await reader.cleanup();
  });

  it("clones the repo root over SSH using git@github.com and returns clone root + listing", async () => {
    mockGitSuccess({
      fixture: async (dir) => {
        await writeFile(join(dir, "README.md"), "hello");
        await mkdir(join(dir, "src"));
      },
    });

    const reader = createGitHubReader();
    const result = await reader.read("https://github.com/octocat/hello-world", new AbortController().signal);

    expect(result).toBeDefined();
    expect(result?.text).toContain("Repository clone root:");
    expect(result?.text).toContain("README.md");
    expect(result?.text).toContain("src");

    const cloneCall = calls().find((call) => call[1][0] === "clone");
    expect(cloneCall).toBeDefined();
    const [, args] = cloneCall as ExecFileCall;
    expect(args).toEqual([
      "clone",
      "--depth",
      "1",
      "--single-branch",
      "git@github.com:octocat/hello-world.git",
      expect.any(String),
    ]);

    await reader.cleanup();
  });

  it("resolves a 40-hex SHA via init/remote add/fetch/checkout, never falling back to an API", async () => {
    mockGitSuccess();
    const sha = "a".repeat(40);
    const reader = createGitHubReader();

    await reader.read(`https://github.com/octocat/hello-world/tree/${sha}`, new AbortController().signal);

    const gitCalls = calls().map((call) => call[1]);
    expect(gitCalls[0]).toEqual(["init", expect.any(String)]);
    expect(gitCalls[1]).toEqual(["remote", "add", "origin", "git@github.com:octocat/hello-world.git"]);
    expect(gitCalls[2]).toEqual(["fetch", "--depth", "1", "origin", sha]);
    expect(gitCalls[3]).toEqual(["checkout", "--detach", "FETCH_HEAD"]);
    // No ls-remote / API-fallback call for a full SHA.
    expect(gitCalls.some((args) => args[0] === "ls-remote")).toBe(false);

    await reader.cleanup();
  });

  it("resolves a branch name containing a slash via ls-remote longest-prefix match", async () => {
    mockGitSuccess({
      refs: ["main", "feature/foo"],
      fixture: async (dir) => {
        await mkdir(join(dir, "src"));
        await writeFile(join(dir, "src", "index.ts"), "export {};");
      },
    });

    const reader = createGitHubReader();
    const result = await reader.read(
      "https://github.com/octocat/hello-world/tree/feature/foo/src",
      new AbortController().signal,
    );

    expect(result?.title).toBe("octocat/hello-world@feature/foo");
    expect(result?.text).toContain("index.ts");

    const cloneCall = calls().find((call) => call[1][0] === "clone");
    expect(cloneCall?.[1]).toEqual([
      "clone",
      "--depth",
      "1",
      "--single-branch",
      "--branch",
      "feature/foo",
      "git@github.com:octocat/hello-world.git",
      expect.any(String),
    ]);

    await reader.cleanup();
  });

  it("reads blob content for a file path under a resolved ref", async () => {
    mockGitSuccess({
      refs: ["main"],
      fixture: async (dir) => {
        await writeFile(join(dir, "package.json"), '{"name":"hello-world"}');
      },
    });

    const reader = createGitHubReader();
    const result = await reader.read(
      "https://github.com/octocat/hello-world/blob/main/package.json",
      new AbortController().signal,
    );

    expect(result?.text).toContain("File: package.json");
    expect(result?.text).toContain('{"name":"hello-world"}');

    await reader.cleanup();
  });

  it("removes the local clone directory on failure and permits a retry", async () => {
    execFileMock.mockImplementation(
      (_file: string, args: string[], opts: Record<string, unknown>, callback: ExecFileCallback) => {
        const dir = dirArgOf(args, opts);
        createdDirs.add(dir);
        if (args[0] === "clone") {
          callback(new Error("git failed"), "", "raw stderr should not leak");
          return;
        }
        callback(null, "", "");
      },
    );

    const reader = createGitHubReader();
    let failedDir: string | undefined;
    try {
      await reader.read("https://github.com/octocat/hello-world", new AbortController().signal);
      throw new Error("expected rejection");
    } catch (err) {
      expect(String(err)).not.toContain("raw stderr should not leak");
      failedDir = calls()
        .find((call) => call[1][0] === "clone")?.[1]
        .slice(-1)[0];
    }
    expect(failedDir).toBeDefined();
    await expect(stat(failedDir as string)).rejects.toThrow();

    // Retry with a working git succeeds and creates a fresh directory.
    mockGitSuccess({
      fixture: async (dir) => {
        await writeFile(join(dir, "README.md"), "hi");
      },
    });
    const result = await reader.read("https://github.com/octocat/hello-world", new AbortController().signal);
    expect(result).toBeDefined();

    await reader.cleanup();
  });

  it("removes only its own cloned directories on cleanup(), leaving the parent cache directory intact", async () => {
    mockGitSuccess({
      fixture: async (dir) => {
        await writeFile(join(dir, "README.md"), "hi");
      },
    });

    const reader = createGitHubReader();
    await reader.read("https://github.com/octocat/hello-world", new AbortController().signal);
    const cloneDir = calls()
      .find((call) => call[1][0] === "clone")?.[1]
      .slice(-1)[0] as string;
    await expect(stat(cloneDir)).resolves.toBeDefined();

    await reader.cleanup();

    await expect(stat(cloneDir)).rejects.toThrow();
    await expect(stat(PARENT_DIR)).resolves.toBeDefined();
  });

  it("rejects reading a path that escapes the repository root via a symlink", async () => {
    mockGitSuccess({
      refs: ["main"],
      fixture: async (dir) => {
        await mkdir(join(dir, "safe"));
        // Symlink inside the clone pointing outside the clone root.
        await symlink("/etc", join(dir, "escape"));
      },
    });

    const reader = createGitHubReader();
    await expect(
      reader.read("https://github.com/octocat/hello-world/blob/main/escape/passwd", new AbortController().signal),
    ).rejects.toThrow();

    await reader.cleanup();
  });

  it("resolves a /commit/<sha> URL by shallow-fetching the exact SHA and returning the root checkout listing", async () => {
    execFileMock.mockImplementation(
      async (_file: string, args: string[], opts: Record<string, unknown>, callback: ExecFileCallback) => {
        const dir = dirArgOf(args, opts);
        createdDirs.add(dir);
        if (args[0] === "checkout") {
          await writeFile(join(dir, "README.md"), "hello");
        }
        callback(null, "", "");
      },
    );
    const sha = "b".repeat(40);
    const reader = createGitHubReader();

    const result = await reader.read(
      `https://github.com/octocat/hello-world/commit/${sha}`,
      new AbortController().signal,
    );

    const gitCalls = calls().map((call) => call[1]);
    expect(gitCalls[0]).toEqual(["init", expect.any(String)]);
    expect(gitCalls[1]).toEqual(["remote", "add", "origin", "git@github.com:octocat/hello-world.git"]);
    expect(gitCalls[2]).toEqual(["fetch", "--depth", "1", "origin", sha]);
    expect(gitCalls[3]).toEqual(["checkout", "--detach", "FETCH_HEAD"]);
    expect(gitCalls.some((args) => args[0] === "ls-remote")).toBe(false);
    expect(gitCalls.some((args) => args[0] === "clone")).toBe(false);
    expect(result?.title).toBe(`octocat/hello-world@${sha}`);
    expect(result?.text).toContain("README.md");

    await reader.cleanup();
  });

  it("rejects malformed /commit/ URLs instead of falling back to Exa", async () => {
    const reader = createGitHubReader();

    await expect(
      reader.read("https://github.com/octocat/hello-world/commit/not-a-sha", new AbortController().signal),
    ).rejects.toThrow("commit URL must reference a single full commit SHA");
    await expect(
      reader.read(
        `https://github.com/octocat/hello-world/commit/${"c".repeat(40)}/extra`,
        new AbortController().signal,
      ),
    ).rejects.toThrow("commit URL must reference a single full commit SHA");
    await expect(
      reader.read("https://github.com/octocat/hello-world/commit/", new AbortController().signal),
    ).rejects.toThrow("commit URL must reference a single full commit SHA");
    expect(execFileMock).not.toHaveBeenCalled();

    await reader.cleanup();
  });

  it("includes the absolute local path of the requested file/directory in blob and tree results", async () => {
    mockGitSuccess({
      refs: ["main"],
      fixture: async (dir) => {
        await mkdir(join(dir, "src"));
        await writeFile(join(dir, "src", "index.ts"), "export {};");
      },
    });

    const reader = createGitHubReader();

    const treeResult = await reader.read(
      "https://github.com/octocat/hello-world/tree/main/src",
      new AbortController().signal,
    );
    expect(treeResult?.text).toMatch(/Local path: .*\/src\b/);

    const blobResult = await reader.read(
      "https://github.com/octocat/hello-world/blob/main/src/index.ts",
      new AbortController().signal,
    );
    expect(blobResult?.text).toMatch(/Local path: .*\/src\/index\.ts\b/);

    await reader.cleanup();
  });

  it("awaits an in-flight clone before removing directories on cleanup(), avoiding a leaked directory", async () => {
    let releaseClone: (() => void) | undefined;
    const cloneGate = new Promise<void>((resolvePromise) => {
      releaseClone = resolvePromise;
    });

    execFileMock.mockImplementation(
      async (_file: string, args: string[], opts: Record<string, unknown>, callback: ExecFileCallback) => {
        const dir = dirArgOf(args, opts);
        createdDirs.add(dir);
        if (args[0] === "clone") {
          await cloneGate;
          await writeFile(join(dir, "README.md"), "hi");
        }
        callback(null, "", "");
      },
    );

    const reader = createGitHubReader();
    const readPromise = reader.read("https://github.com/octocat/hello-world", new AbortController().signal);

    // Give the clone a tick to start (mkdtemp + reach the gated clone call).
    await new Promise((r) => setTimeout(r, 10));

    const cleanupPromise = reader.cleanup();
    releaseClone?.();

    const [result] = await Promise.all([readPromise, cleanupPromise]);
    expect(result).toBeDefined();

    const cloneDir = calls()
      .find((call) => call[1][0] === "clone")?.[1]
      .slice(-1)[0] as string;
    await expect(stat(cloneDir)).rejects.toThrow();
  });

  it("rejects a new read after cleanup() even if it was awaiting ref resolution when cleanup started", async () => {
    let releaseLsRemote: (() => void) | undefined;
    const lsRemoteGate = new Promise<void>((resolvePromise) => {
      releaseLsRemote = resolvePromise;
    });

    execFileMock.mockImplementation(
      async (_file: string, args: string[], opts: Record<string, unknown>, callback: ExecFileCallback) => {
        const dir = dirArgOf(args, opts);
        createdDirs.add(dir);
        if (args[0] === "ls-remote") {
          await lsRemoteGate;
          callback(null, "abc123\trefs/heads/main", "");
          return;
        }
        callback(null, "", "");
      },
    );

    const reader = createGitHubReader();
    const readPromise = reader.read("https://github.com/octocat/hello-world/tree/main", new AbortController().signal);

    await new Promise((r) => setTimeout(r, 10));
    const cleanupPromise = reader.cleanup();
    releaseLsRemote?.();

    await expect(readPromise).rejects.toThrow("github: reader is closed");
    await cleanupPromise;
    expect(calls().some((call) => call[1][0] === "clone")).toBe(false);
  });
});
