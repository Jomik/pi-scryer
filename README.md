# pi-scryer

Exa and Tavily web access for [pi](https://github.com/earendil-works/pi). Provides
`web_read` and `web_search` with keyed and anonymous provider routes.

## Installation

```
pi install npm:pi-scryer
```

## Trial

Run without installing:

```
pi -e npm:pi-scryer
```

## Configuration

No API key is required: Exa's hosted MCP search/fetch and Tavily's keyless
REST search/extract provide anonymous, rate-limited access. Optional keys enable
keyed routes. Exa's keyed route uses the Exa REST API; Tavily's keyed route uses
`TAVILY_API_KEY` from the environment (no Tavily Keychain or `/scryer` login).

For an optional Exa key on macOS, run `/scryer login` in an interactive
session to store it in the macOS Keychain (fixed service `pi-scryer`, account
`exa-api-key`). This is the recommended path: the key is stored securely by
the OS and is never written to any project, session, or cache file.

On headless macOS or any other platform, set the Exa environment variable
instead:

```
export EXA_API_KEY=...
```

Other `/scryer` subcommands:

- `/scryer status` — reports which source will supply the Exa key (`Keychain`,
  `environment`, or `missing`) without reading or revealing its value. It does
  not check balance, route health, or Tavily credentials.
- `/scryer logout` — removes the Keychain item (macOS only, idempotent).
  Does not touch the `EXA_API_KEY` environment variable; if it is still set,
  it remains available as a fallback.

Precedence: on macOS, the Keychain is checked first; if it is missing,
empty, or inaccessible, the trimmed `EXA_API_KEY` environment variable is
used instead. On non-macOS platforms, only the environment variable is
consulted. The key itself is never shown in any notification, and never
stored or cached in any project, session, or cache file. Anonymous requests
never send a configured API key. Tavily captures `TAVILY_API_KEY` when the
extension activates; Exa's keyed-route presence is determined on the first
hosted search or read. Credential changes (including `/scryer login` and
`/scryer logout`) require restarting Pi to change active routes. Restarting
also resets route availability.

## Provider routing

Each fresh `web_search` or non-GitHub `web_read` randomly starts with a provider
that has an available route (Exa or Tavily). Within that provider it tries the
keyed route if configured, then its anonymous route; only then does it try the
other provider, also keyed before anonymous. Attempts are sequential, not
parallel queries. Successful output identifies the provider and access mode;
`web_read` continuation chunks retain the original provider and mode. Empty
search results may prompt another route; if all routes return no matches, the
result is "No search results found."

Quota exhaustion or invalid credentials disable only the affected route until
process restart. Rate limits skip a route until its retry time, or for 30
seconds when none is supplied. Other transient failures fall through to the
next route for that request and can be retried on a later request; a failed
route is not retried within the same request. If no route succeeds, the tool
reports a sanitized failure instead of returning partial content. Neither
`/scryer status` nor a successful request reveals remaining free-tier balance:
this extension cannot guarantee free-tier-only billing. Set provider-side
spending caps or disable overages if a hard spending limit is required.

## Tools

### `web_read`

`web_read(url, offset?)` fetches a URL's content and returns the resolved
source and extracted text; the title is included only when available.

- HTTP(S) URLs only.
- Fixed 30s timeout.
- Output limited to 50KB or 2000 lines per call, whichever is hit first.
- **GitHub code URLs:** repo root, `/tree/<ref>[/path]`, `/blob/<ref>/path`,
  `/commit/<sha>`, and `/raw/<ref>/path` URLs on `github.com`, plus
  `raw.githubusercontent.com/OWNER/REPO/<ref>/path`, are read directly by
  shallow-cloning the repository over HTTPS via the `gh` CLI (`gh repo clone
  https://github.com/owner/repo.git`) instead of going through a hosted
  provider — content is never sent to Exa or Tavily for these URLs.
  `github.com/OWNER/REPO/raw/<ref>/path`
  and `raw.githubusercontent.com/OWNER/REPO/<ref>/path` are resolved and read
  identically to `/blob/<ref>/path` (single-file content, not a directory
  listing). This requires `gh` to be installed and
  authenticated (`gh auth login` / `gh auth status`); it does not require an
  SSH agent or key, since the clone always uses an explicit HTTPS remote URL
  (which overrides `gh`'s configured `git_protocol`). `gh` itself delegates
  the clone to `git`, and does not install or configure any global git
  credential helper as a side effect — `web_read` passes per-invocation
  `-c credential.helper=` (resetting any already-configured helper chain, so
  the user's global credential helper cannot supply or override credentials)
  followed by `-c credential.helper=!gh auth git-credential` arguments to the
  `git` commands it runs directly (`ls-remote`, and the exact-SHA `fetch`),
  so those reuse `gh`'s stored credentials without touching global git
  config. Clones are shallow and cached per-repository/ref for the lifetime
  of the process, under a stable `/tmp/pi-scryer` root with a unique
  per-clone child directory; only the child directories created by this
  process are removed on graceful shutdown, and the stable root itself is
  left in place. A `/commit/<sha>` URL reuses this reader's cached clone if
  that exact SHA was already fetched; a different commit SHA (or repository)
  triggers a fresh `git init` of an empty directory, `git remote add origin
  https://github.com/owner/repo.git`, and a `git fetch --depth 1 origin
  <sha>` (authenticated via `gh auth git-credential`) followed by a detached
  checkout of `FETCH_HEAD` — only the single requested commit is ever
  transferred, never the default branch. Blob content is capped at 100,000
  bytes before `offset` chunking; use the returned local path to read larger
  files.
  If cloning, authentication, or the git fetch fails for a recognized GitHub
  code URL, `web_read` throws — it never falls back to Exa or Tavily for
  these URLs.
- **GitHub issue/pull request URLs:** `github.com/OWNER/REPO/issues/<n>` and
  `github.com/OWNER/REPO/pull/<n>` (also `www.github.com`; exactly these 4
  path segments, an optional trailing slash or query string is fine, `<n>` a
  positive decimal integer) are read directly via the authenticated `gh` CLI
  (`gh issue view`/`gh pr view --repo OWNER/REPO --json
  title,body,comments,url`) — no clone, no temporary directory, and no call
  to Exa or Tavily is ever made for these URLs. Only the issue/PR's title,
  body, and general (top-level) comments are included; inline pull request review
  comment threads on the diff are not fetched. If `gh` is missing, fails, or
  returns no content, `web_read` throws — it never falls back to Exa or Tavily.
- Every other GitHub-owned URL is rejected outright instead of
  being sent to Exa or Tavily: this includes other `github.com` paths such as
  malformed issue/pull URLs (extra segments, non-numeric or malformed
  numbers) and profile pages; any `github.com` subdomain (`gist.github.com`,
  `api.github.com`, etc.); and `githubusercontent.com` / any other
  `*.githubusercontent.com` subdomain (`raw.githubusercontent.com` is the one
  supported exception, handled above),
  since these can serve private repository content that must never be leaked
  to a third-party content provider. On fresh reads, `web_read` throws a clear
  unsupported-GitHub-URL error for these instead of returning `undefined` and
  falling through to either hosted provider. Any continuation request
  (`offset > 0`) that misses the cache fails with
  `web_read: continuation expired; restart with offset 0` before GitHub
  classification, without calling a hosted provider. Only URLs on
  genuinely unrelated sites are fetched via hosted providers.
- Non-GitHub URLs are extracted by Exa or Tavily; there is no direct local
  fetch of arbitrary websites, authenticated pages, or private-network URLs.
- **Continuing long pages:** when a page's extracted text does not fit in one
  call, the response ends with a marker stating the current offset, the exact
  next offset, the total text length, and the call to make next, e.g.
  `web_read(url, offset: N)`. Pass that exact `N` back as `offset` to fetch
  the next chunk — do not compute your own offset. Offsets are exact
  positions into the previously returned page text; copy them verbatim. The
  final chunk has no continuation marker.
- Omitting `offset` (or passing `0`) always fetches the page fresh (via the
  GitHub reader or hosted provider routing, per the rules above), replacing
  (or removing, if the fresh page fits in one call) that URL's cache entry.
- The extension caches up to 5 pages' continuation state in a private,
  per-process temp directory (not shared between agents or processes). A
  continuation call (`offset > 0`) reuses a cached entry only when it targets
  the same URL as a cached fetch, keeping its provider and mode without a new
  provider request. Otherwise (a different URL, a corrupted or missing cache
  file, an evicted entry, or a fresh process), it fails and asks you to restart
  with `offset: 0` rather than applying an old offset to a fresh extraction.
  The 6th distinct page evicts the least-recently-used cached entry; reading a
  cached entry refreshes it.
  Finishing a page (reaching its last chunk) removes its cache entry. The
  cache directory is cleaned up on graceful shutdown and is otherwise
  abandoned to OS temp-directory cleanup if the process crashes.
- Each hosted request has a 30s timeout. Failed routes fall back as described
  above; GitHub reader failures never fall back to hosted providers.

### `web_search`

`web_search(query)` searches the web through Exa or Tavily and returns up to 5
results as Markdown. Every valid result has a source URL; a title and a short
excerpt (up to 500 characters) are included when the provider supplies them.
Titles are collapsed to one line and truncated to at most 200 characters.
Malformed search entries may be omitted, and the output reports the omitted
count.

- Fixed result count (5) and excerpt length; no pagination or batching.
- Each hosted request has a 30s timeout; route fallback follows the rules above.
- Does not fetch full page content — call `web_read` on a returned source URL
  to read the full page. No direct local fetch of arbitrary websites.

## Development

```
npm install
npm run lint
npm run typecheck
npm test
```

## License

MIT
