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
// Decimal positive integer with no leading zero, sign, or non-digit
// characters; matches gh CLI's accepted issue/PR number shape.
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;

export interface GitHubReader {
  read(url: string, signal: AbortSignal | undefined): Promise<ExaContentResult | undefined>;
  cleanup(): Promise<void>;
}

type ParsedTarget =
  | { kind: "root" }
  | { kind: "tree"; refAndPath: string[] }
  | { kind: "blob"; refAndPath: string[] }
  | { kind: "commit"; sha: string }
  | { kind: "issue"; number: string }
  | { kind: "pull"; number: string };

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

const UNSUPPORTED_GITHUB_URL_MESSAGE =
  "github: unsupported GitHub URL — rejected to protect private data. Only repo root, /tree/<ref>[/path], /blob/<ref>/path, /commit/<sha>, and /raw/<ref>/path URLs on github.com, plus raw.githubusercontent.com/OWNER/REPO/<ref>/path, can be read; this includes github.com subdomains (gist, api, ...) and other githubusercontent.com hosts.";

/**
 * True for github.com, any *.github.com subdomain, githubusercontent.com,
 * and any *.githubusercontent.com subdomain. Uses exact-match/dot-suffix
 * checks on the lowercased hostname so lookalike domains such as
 * "github.com.evil.example" are not matched.
 */
function isGitHubOwnedHost(host: string): boolean {
  return (
    host === "github.com" ||
    host.endsWith(".github.com") ||
    host === "githubusercontent.com" ||
    host.endsWith(".githubusercontent.com")
  );
}

/**
 * Parses a URL as a GitHub code reference, or as an issue/pull request
 * reference. Returns undefined only for URLs that are not GitHub-owned at
 * all. For any GitHub-owned host (github.com, any *.github.com subdomain,
 * githubusercontent.com, any *.githubusercontent.com subdomain) that does
 * not address a supported repository code reference or a supported
 * issue/pull reference (profile pages, gist/api subdomains, non-raw
 * githubusercontent.com hosts, etc.), this throws instead of returning
 * undefined so callers fail closed rather than fall back to a remote
 * content provider. Also throws for github.com repo-code-shaped URLs that
 * are otherwise malformed (credentials, custom port, invalid owner/repo,
 * traversal, missing ref).
 *
 * Two raw-content routes are recognized and parsed as a blob target
 * (identical ref/path resolution and reading as /blob/<ref>/path):
 * raw.githubusercontent.com/OWNER/REPO/<ref>/<path> and
 * github.com/OWNER/REPO/raw/<ref>/<path> (also www.github.com).
 *
 * github.com/OWNER/REPO/issues/<n> and github.com/OWNER/REPO/pull/<n>
 * (also www.github.com) are recognized as issue/pull targets when the path
 * has exactly these 4 segments (an optional trailing slash and query string
 * are fine) and <n> is a positive decimal integer with no leading zero,
 * sign, or extra characters; anything else under /issues/ or /pull/
 * (extra segments, non-numeric or malformed numbers) throws instead of
 * falling back.
 */
export function parseGitHubUrl(rawUrl: string): ParsedGitHubUrl | undefined {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return undefined;
  }

  const host = parsed.hostname.toLowerCase();
  if (!isGitHubOwnedHost(host)) {
    return undefined;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(UNSUPPORTED_GITHUB_URL_MESSAGE);
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new Error("github: URL must not contain credentials");
  }
  if (parsed.port.length > 0) {
    throw new Error("github: URL must not specify a custom port");
  }
  const isRawContentHost = host === "raw.githubusercontent.com";
  if (host !== "github.com" && host !== "www.github.com" && !isRawContentHost) {
    // Other GitHub-owned hosts (gist.github.com, api.github.com,
    // githubusercontent.com, other githubusercontent.com subdomains, ...)
    // never address a clonable repository code reference.
    throw new Error(UNSUPPORTED_GITHUB_URL_MESSAGE);
  }

  const rawSegments = parsed.pathname.split("/").filter((segment) => segment.length > 0);
  if (rawSegments.length < 2) {
    throw new Error(UNSUPPORTED_GITHUB_URL_MESSAGE);
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

  if (isRawContentHost) {
    // raw.githubusercontent.com/OWNER/REPO/<ref>/<path>: no "blob"/"tree"
    // keyword segment; the remainder is the same ref-then-path shape as a
    // /blob/<ref>/path URL, resolved and read identically.
    const refAndPath = segments.slice(2);
    if (refAndPath.length === 0) {
      throw new Error("github: raw URL is missing a ref");
    }
    return { owner, repo, target: { kind: "blob", refAndPath } };
  }

  if (segments.length === 2) {
    return { owner, repo, target: { kind: "root" } };
  }

  const kind = segments[2];
  if (kind === "issues" || kind === "pull") {
    // Exactly 4 path segments (owner, repo, issues|pull, number): reject
    // extra segments (e.g. /pull/5/files) rather than trying to parse a
    // partial match.
    if (segments.length !== 4 || !POSITIVE_INTEGER_PATTERN.test(segments[3])) {
      throw new Error(UNSUPPORTED_GITHUB_URL_MESSAGE);
    }
    return {
      owner,
      repo,
      target: { kind: kind === "issues" ? "issue" : "pull", number: segments[3] },
    };
  }
  if (kind !== "tree" && kind !== "blob" && kind !== "commit" && kind !== "raw") {
    throw new Error(UNSUPPORTED_GITHUB_URL_MESSAGE);
  }

  if (kind === "commit") {
    const commitSegments = segments.slice(3);
    if (commitSegments.length !== 1 || !SHA_PATTERN.test(commitSegments[0])) {
      throw new Error("github: commit URL must reference a single full commit SHA");
    }
    return { owner, repo, target: { kind: "commit", sha: commitSegments[0].toLowerCase() } };
  }

  const refAndPath = segments.slice(3);
  if (refAndPath.length === 0) {
    throw new Error(`github: ${kind} URL is missing a ref`);
  }

  // github.com/OWNER/REPO/raw/<ref>/<path> reads identically to
  // /blob/<ref>/path (single-file content, not a directory listing).
  return { owner, repo, target: { kind: kind === "raw" ? "blob" : kind, refAndPath } };
}

function remoteUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}.git`;
}

/**
 * Per-command (never global) git arguments that route credential lookups
 * for the given invocation through `gh auth git-credential`, so ls-remote
 * and fetch reuse `gh`'s stored HTTPS credentials without writing to any
 * global git config. The leading `credential.helper=` resets any
 * already-configured helper chain (e.g. the user's global credential
 * helper) so it cannot supply or override credentials ahead of `gh`.
 */
const CREDENTIAL_HELPER_ARGS = ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"];

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

/**
 * Clones via the `gh` CLI, which delegates the actual clone to git but
 * authenticates over HTTPS using `gh`'s stored credentials. Since `remote`
 * is always an explicit `https://github.com/...` URL, `gh`'s configured
 * `git_protocol` (which may default to `ssh`) is overridden and only `gh
 * auth login` (no SSH agent/key) is required.
 */
function execGh(args: string[], options: { signal?: AbortSignal }): Promise<{ stdout: string }> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      "gh",
      args,
      {
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        timeout: GIT_TIMEOUT_MS,
        signal: options.signal,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout) => {
        if (error) {
          reject(new Error("github: gh command failed"));
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
  const header = `Repository clone root: ${cloneDir}\nFile: ${relPath}\nLocal path: ${filePath}\nExplore other files with filesystem tools under the clone root.\n\n`;
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
  const header = `Repository clone root: ${cloneDir}\nPath: ${relPath}\nLocal path: ${dirPath}\nExplore other files with filesystem tools under the clone root.\n\n`;
  return `${header}${lines.length > 0 ? lines.join("\n") : "(empty directory)"}`;
}

/**
 * Creates a GitHub reader backend that fetches repository content over
 * HTTPS into a private per-parent cache directory, never sending
 * repository URLs to Exa. Default-branch and named-ref requests clone via
 * the `gh` CLI (`gh repo clone https://github.com/OWNER/REPO.git`), whose
 * explicit HTTPS remote overrides `gh`'s configured `git_protocol` so only
 * `gh auth login` (not an SSH agent/key) is required; `gh` delegates the
 * actual clone to git. Full-SHA requests instead `git init` an empty
 * directory, add the HTTPS remote, and `git fetch --depth 1 origin <sha>`
 * authenticated via `gh auth git-credential`, so only the single requested
 * commit (not the default branch) is ever transferred. Reuses successful
 * clones for the same repository/ref within this reader instance, and
 * removes only the local clone directories it created on cleanup(). Issue
 * and pull request URLs never clone or fetch anything: they are read
 * directly via `gh issue view`/`gh pr view --json title,body,comments,url`,
 * returning only general issue/PR comments (inline review comment threads
 * on a pull request's diff are not included).
 */
export function createGitHubReader(): GitHubReader {
  const cloneDirs = new Map<string, string>();
  const cloneLocks = new Map<string, Promise<string>>();
  const refsCache = new Map<string, Promise<string[]>>();
  const pendingClones = new Set<Promise<void>>();
  let parentDirPromise: Promise<string> | undefined;
  let closed = false;

  function trackPending(promise: Promise<unknown>): void {
    const settled = promise.then(
      () => undefined,
      () => undefined,
    );
    pendingClones.add(settled);
    settled.finally(() => pendingClones.delete(settled));
  }

  function getParentDir(): Promise<string> {
    if (!parentDirPromise) {
      parentDirPromise = ensureParentDir().catch((err) => {
        parentDirPromise = undefined;
        throw err;
      });
    }
    return parentDirPromise;
  }

  function listRemoteRefs(remote: string, repoKey: string, signal: AbortSignal | undefined): Promise<string[]> {
    let cached = refsCache.get(repoKey);
    if (!cached) {
      cached = execGit([...CREDENTIAL_HELPER_ARGS, "ls-remote", "--heads", "--tags", remote], { signal })
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
    signal: AbortSignal | undefined,
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
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const cached = cloneDirs.get(cacheKey);
    if (cached) {
      return cached;
    }

    if (closed) {
      throw new Error("github: reader is closed");
    }

    let inFlight = cloneLocks.get(cacheKey);
    if (!inFlight) {
      inFlight = (async () => {
        const parent = await getParentDir();
        const dir = await mkdtemp(join(parent, CLONE_DIR_PREFIX));
        try {
          if (refKind === "sha" && ref) {
            await execGit(["init", "--quiet", dir], { signal });
            await execGit(["remote", "add", "origin", remote], { cwd: dir, signal });
            await execGit([...CREDENTIAL_HELPER_ARGS, "fetch", "--depth", "1", "origin", ref], {
              cwd: dir,
              signal,
            });
            await execGit(["checkout", "--detach", "FETCH_HEAD"], { cwd: dir, signal });
          } else if (refKind === "ref" && ref) {
            await execGh(["repo", "clone", remote, dir, "--", "--depth", "1", "--single-branch", "--branch", ref], {
              signal,
            });
          } else {
            await execGh(["repo", "clone", remote, dir, "--", "--depth", "1", "--single-branch"], { signal });
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
      trackPending(inFlight);
      cloneLocks.set(cacheKey, inFlight);
    }
    return inFlight;
  }

  async function read(url: string, signal: AbortSignal | undefined): Promise<ExaContentResult | undefined> {
    const parsed = parseGitHubUrl(url);
    if (!parsed) {
      return undefined;
    }
    if (closed) {
      throw new Error("github: reader is closed");
    }
    const { owner, repo, target } = parsed;

    if (target.kind === "issue" || target.kind === "pull") {
      const { stdout } = await execGh(
        [
          target.kind === "issue" ? "issue" : "pr",
          "view",
          target.number,
          "--repo",
          `${owner}/${repo}`,
          "--json",
          "title,body,comments,url",
        ],
        { signal },
      );
      const text = stdout.trim();
      if (text.length === 0) {
        throw new Error("github: gh returned no content for this issue or pull request");
      }
      return { url, title: `${owner}/${repo}#${target.number}`, text };
    }

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
    } else if (target.kind === "commit") {
      refKind = "sha";
      ref = target.sha;
    }

    if (closed) {
      throw new Error("github: reader is closed");
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
    closed = true;
    await Promise.allSettled([...pendingClones]);
    const dirs = [...cloneDirs.values()];
    cloneDirs.clear();
    for (const dir of dirs) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  return { read, cleanup };
}
