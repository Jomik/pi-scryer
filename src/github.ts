import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ExaContentResult } from "./exa";

const GITHUB_TMP_PARENT = "/tmp/pi-scryer";
const CLONE_DIR_PREFIX = "repo-";
const GIT_TIMEOUT_MS = 30_000;
const MAX_BLOB_BYTES = 100_000;
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/i;

export interface GitHubReader {
  read(url: string, signal: AbortSignal): Promise<ExaContentResult | undefined>;
  cleanup(): Promise<void>;
}

type ParsedTarget = { kind: "root" } | { kind: "tree"; refAndPath: string[] } | { kind: "blob"; refAndPath: string[] };

interface ParsedGitHubUrl {
  owner: string;
  repo: string;
  target: ParsedTarget;
}

/**
 * Rejects a decoded URL path segment that could enable traversal or
 * ambiguous re-splitting: empty, ".", "..", or containing a NUL byte or an
 * embedded path separator (from percent-encoded "/").
 */
function assertSafeSegment(segment: string): void {
  if (
    segment.length === 0 ||
    segment === "." ||
    segment === ".." ||
    segment.includes("\0") ||
    segment.includes("/") ||
    segment.includes("\\")
  ) {
    throw new Error("github: URL path contains an invalid path segment");
  }
}

/**
 * Parses a URL as a GitHub code reference. Returns undefined for URLs that
 * are not on github.com/www.github.com, or that are github.com URLs but do
 * not address a repository's code (profile pages, issues, pulls, etc.).
 * Throws for github.com repo-code-shaped URLs that are otherwise malformed
 * (credentials, custom port, invalid owner/repo, traversal, missing ref).
 */
export function parseGitHubUrl(rawUrl: string): ParsedGitHubUrl | undefined {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return undefined;
  }

  const host = parsed.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") {
    return undefined;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return undefined;
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new Error("github: URL must not contain credentials");
  }
  if (parsed.port.length > 0) {
    throw new Error("github: URL must not specify a custom port");
  }

  const rawSegments = parsed.pathname.split("/").filter((segment) => segment.length > 0);
  if (rawSegments.length < 2) {
    return undefined;
  }

  let segments: string[];
  try {
    segments = rawSegments.map((segment) => decodeURIComponent(segment));
  } catch {
    throw new Error("github: URL path is malformed");
  }
  for (const segment of segments) {
    assertSafeSegment(segment);
  }

  const owner = segments[0];
  let repo = segments[1];
  if (repo.toLowerCase().endsWith(".git")) {
    repo = repo.slice(0, -4);
  }
  if (!OWNER_PATTERN.test(owner) || !REPO_PATTERN.test(repo)) {
    throw new Error("github: malformed owner or repository name");
  }

  if (segments.length === 2) {
    return { owner, repo, target: { kind: "root" } };
  }

  const kind = segments[2];
  if (kind !== "tree" && kind !== "blob") {
    return undefined;
  }

  const refAndPath = segments.slice(3);
  if (refAndPath.length === 0) {
    throw new Error(`github: ${kind} URL is missing a ref`);
  }

  return { owner, repo, target: { kind, refAndPath } };
}

function remoteUrl(owner: string, repo: string): string {
  return `git@github.com:${owner}/${repo}.git`;
}

function execGit(args: string[], options: { cwd?: string; signal?: AbortSignal }): Promise<{ stdout: string }> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      "git",
      args,
      {
        cwd: options.cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        timeout: GIT_TIMEOUT_MS,
        signal: options.signal,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout) => {
        if (error) {
          reject(new Error("github: git command failed"));
          return;
        }
        resolvePromise({ stdout: typeof stdout === "string" ? stdout : String(stdout ?? "") });
      },
    );
  });
}

function parseRefNames(lsRemoteOutput: string): string[] {
  const names: string[] = [];
  for (const line of lsRemoteOutput.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab === -1) {
      continue;
    }
    const refPath = line.slice(tab + 1).trim();
    if (refPath.startsWith("refs/heads/")) {
      names.push(refPath.slice("refs/heads/".length));
    } else if (refPath.startsWith("refs/tags/") && !refPath.endsWith("^{}")) {
      names.push(refPath.slice("refs/tags/".length));
    }
  }
  return names;
}

async function ensureParentDir(): Promise<string> {
  try {
    const info = await lstat(GITHUB_TMP_PARENT);
    if (info.isSymbolicLink()) {
      throw new Error("github: refusing to use a symlinked cache parent directory");
    }
    if (!info.isDirectory()) {
      throw new Error("github: cache parent path is not a directory");
    }
    const uid = process.getuid?.();
    if (uid !== undefined && info.uid !== uid) {
      throw new Error("github: cache parent directory is not owned by the current user");
    }
    if ((info.mode & 0o777) !== 0o700) {
      throw new Error("github: cache parent directory has unsafe permissions");
    }
    return GITHUB_TMP_PARENT;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw err;
    }
    try {
      await mkdir(GITHUB_TMP_PARENT, { mode: 0o700 });
    } catch (mkErr) {
      if ((mkErr as NodeJS.ErrnoException)?.code === "EEXIST") {
        return ensureParentDir();
      }
      throw new Error("github: failed to create cache parent directory");
    }
    await chmod(GITHUB_TMP_PARENT, 0o700).catch(() => {});
    return GITHUB_TMP_PARENT;
  }
}

async function resolveWithinRoot(root: string, target: string): Promise<{ realRoot: string; realPath: string }> {
  let real: string;
  try {
    real = await realpath(target);
  } catch {
    throw new Error("github: requested path does not exist in the repository");
  }
  const realRoot = await realpath(resolve(root));
  if (real === realRoot) {
    return { realRoot, realPath: real };
  }
  const rel = relative(realRoot, real);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("github: requested path escapes the repository root");
  }
  return { realRoot, realPath: real };
}

async function readBlobText(cloneDir: string, realRoot: string, filePath: string): Promise<string> {
  const info = await lstat(filePath);
  if (info.isSymbolicLink()) {
    throw new Error("github: refusing to read a symlinked file");
  }
  if (!info.isFile()) {
    throw new Error("github: requested path is not a file");
  }
  const cappedSize = Math.min(MAX_BLOB_BYTES, info.size);
  const buffer = Buffer.alloc(Math.max(cappedSize, 0));
  const fh = await open(filePath, "r");
  let bytesRead = 0;
  try {
    if (buffer.length > 0) {
      ({ bytesRead } = await fh.read(buffer, 0, buffer.length, 0));
    }
  } finally {
    await fh.close();
  }
  const truncated = info.size > MAX_BLOB_BYTES;
  const content = buffer.subarray(0, bytesRead).toString("utf-8");
  const relPath = relative(realRoot, filePath);
  const header = `Repository clone root: ${cloneDir}\nFile: ${relPath}\n\n`;
  return truncated
    ? `${header}${content}\n\n[truncated at ${MAX_BLOB_BYTES} bytes of ${info.size}]`
    : `${header}${content}`;
}

async function readTreeListing(cloneDir: string, realRoot: string, dirPath: string): Promise<string> {
  const info = await lstat(dirPath);
  if (info.isSymbolicLink()) {
    throw new Error("github: refusing to list a symlinked directory");
  }
  if (!info.isDirectory()) {
    throw new Error("github: requested path is not a directory");
  }
  const entries = await readdir(dirPath, { withFileTypes: true });
  const lines = entries
    .filter((entry) => entry.name !== ".git")
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => {
      const type = entry.isDirectory() ? "dir " : entry.isSymbolicLink() ? "link" : "file";
      return `${type}  ${entry.name}`;
    });
  const relPath = relative(realRoot, dirPath) || ".";
  const header = `Repository clone root: ${cloneDir}\nPath: ${relPath}\n\n`;
  return `${header}${lines.length > 0 ? lines.join("\n") : "(empty directory)"}`;
}

/**
 * Creates a GitHub reader backend that clones repository content via SSH
 * (git@github.com) into a private per-parent cache directory, never sending
 * repository URLs to Exa. Reuses successful clones for the same
 * repository/ref within this reader instance, and removes only the local
 * clone directories it created on cleanup().
 */
export function createGitHubReader(): GitHubReader {
  const cloneDirs = new Map<string, string>();
  const cloneLocks = new Map<string, Promise<string>>();
  const refsCache = new Map<string, Promise<string[]>>();
  let parentDirPromise: Promise<string> | undefined;

  function getParentDir(): Promise<string> {
    if (!parentDirPromise) {
      parentDirPromise = ensureParentDir().catch((err) => {
        parentDirPromise = undefined;
        throw err;
      });
    }
    return parentDirPromise;
  }

  function listRemoteRefs(remote: string, repoKey: string, signal: AbortSignal): Promise<string[]> {
    let cached = refsCache.get(repoKey);
    if (!cached) {
      cached = execGit(["ls-remote", "--heads", "--tags", remote], { signal })
        .then(({ stdout }) => parseRefNames(stdout))
        .catch((err) => {
          refsCache.delete(repoKey);
          throw err;
        });
      refsCache.set(repoKey, cached);
    }
    return cached;
  }

  async function resolveRefAndPath(
    refAndPath: string[],
    remote: string,
    repoKey: string,
    signal: AbortSignal,
  ): Promise<{ refKind: "sha" | "ref"; ref: string; pathSegments: string[] }> {
    const first = refAndPath[0];
    if (SHA_PATTERN.test(first)) {
      return { refKind: "sha", ref: first.toLowerCase(), pathSegments: refAndPath.slice(1) };
    }

    const knownRefs = await listRemoteRefs(remote, repoKey, signal);
    let matched: string | undefined;
    for (let count = refAndPath.length; count >= 1; count--) {
      const candidate = refAndPath.slice(0, count).join("/");
      if (knownRefs.includes(candidate)) {
        matched = candidate;
        break;
      }
    }
    if (!matched || matched.startsWith("-")) {
      throw new Error("github: could not resolve ref for this URL");
    }
    const matchedSegmentCount = matched.split("/").length;
    return { refKind: "ref", ref: matched, pathSegments: refAndPath.slice(matchedSegmentCount) };
  }

  async function getOrCreateClone(
    cacheKey: string,
    refKind: "sha" | "ref" | "default",
    ref: string | undefined,
    remote: string,
    signal: AbortSignal,
  ): Promise<string> {
    const cached = cloneDirs.get(cacheKey);
    if (cached) {
      return cached;
    }

    let inFlight = cloneLocks.get(cacheKey);
    if (!inFlight) {
      inFlight = (async () => {
        const parent = await getParentDir();
        const dir = await mkdtemp(join(parent, CLONE_DIR_PREFIX));
        try {
          if (refKind === "sha" && ref) {
            await execGit(["init", dir], { signal });
            await execGit(["remote", "add", "origin", remote], { cwd: dir, signal });
            await execGit(["fetch", "--depth", "1", "origin", ref], { cwd: dir, signal });
            await execGit(["checkout", "--detach", "FETCH_HEAD"], { cwd: dir, signal });
          } else if (refKind === "ref" && ref) {
            await execGit(["clone", "--depth", "1", "--single-branch", "--branch", ref, remote, dir], { signal });
          } else {
            await execGit(["clone", "--depth", "1", "--single-branch", remote, dir], { signal });
          }
          cloneDirs.set(cacheKey, dir);
          return dir;
        } catch (err) {
          await rm(dir, { recursive: true, force: true }).catch(() => {});
          throw err instanceof Error ? err : new Error("github: failed to clone repository content");
        } finally {
          cloneLocks.delete(cacheKey);
        }
      })();
      cloneLocks.set(cacheKey, inFlight);
    }
    return inFlight;
  }

  async function read(url: string, signal: AbortSignal): Promise<ExaContentResult | undefined> {
    const parsed = parseGitHubUrl(url);
    if (!parsed) {
      return undefined;
    }
    const { owner, repo, target } = parsed;
    const remote = remoteUrl(owner, repo);
    const repoKey = `${owner}/${repo}`;

    let refKind: "sha" | "ref" | "default" = "default";
    let ref: string | undefined;
    let pathSegments: string[] = [];
    const isBlob = target.kind === "blob";

    if (target.kind === "tree" || target.kind === "blob") {
      const resolved = await resolveRefAndPath(target.refAndPath, remote, repoKey, signal);
      refKind = resolved.refKind;
      ref = resolved.ref;
      pathSegments = resolved.pathSegments;
      if (isBlob && pathSegments.length === 0) {
        throw new Error("github: blob URL must include a file path");
      }
    }

    const cacheKey = `${repoKey}::${refKind}::${ref ?? "default"}`;
    const cloneDir = await getOrCreateClone(cacheKey, refKind, ref, remote, signal);

    const requestedPath = join(cloneDir, ...pathSegments);
    const { realRoot, realPath } = await resolveWithinRoot(cloneDir, requestedPath);

    const text = isBlob
      ? await readBlobText(cloneDir, realRoot, realPath)
      : await readTreeListing(cloneDir, realRoot, realPath);

    return {
      url,
      title: `${owner}/${repo}${ref ? `@${ref}` : ""}`,
      text,
    };
  }

  async function cleanup(): Promise<void> {
    const dirs = [...cloneDirs.values()];
    cloneDirs.clear();
    for (const dir of dirs) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  return { read, cleanup };
}
