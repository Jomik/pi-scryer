# pi-scryer

Minimal Exa web access for [pi](https://github.com/earendil-works/pi). Provides
`web_read` and `web_search`.

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

Requires an Exa API key.

On macOS, run `/scryer login` in an interactive session to store the key in
the macOS Keychain (fixed service `pi-scryer`, account `exa-api-key`). This
is the recommended path: the key is stored securely by the OS and is never
written to any project, session, or cache file.

On headless macOS or any other platform, set the environment variable
instead:

```
export EXA_API_KEY=...
```

Other `/scryer` subcommands:

- `/scryer status` — reports which source will supply the key (`Keychain`,
  `environment`, or `missing`) without reading or revealing its value.
- `/scryer logout` — removes the Keychain item (macOS only, idempotent).
  Does not touch the `EXA_API_KEY` environment variable; if it is still set,
  it remains available as a fallback.

Precedence: on macOS, the Keychain is checked first; if it is missing,
empty, or inaccessible, the trimmed `EXA_API_KEY` environment variable is
used instead. On non-macOS platforms, only the environment variable is
consulted. The key itself is never shown in any notification, and never
stored or cached in any project, session, or cache file.

## Tools

### `web_read`

`web_read(url, offset?)` fetches a URL's content and returns the resolved
source and extracted text; the title is included only when available.

- HTTP(S) URLs only.
- Fixed 30s timeout.
- Output limited to 50KB or 2000 lines per call, whichever is hit first.
- **GitHub code URLs:** repo root, `/tree/<ref>[/path]`, `/blob/<ref>/path`,
  and `/commit/<sha>` URLs on `github.com` are read directly by shallow-cloning
  the repository over SSH (`git@github.com:owner/repo.git`) instead of going
  through Exa — content is never sent to Exa for these URLs. This requires a
  working SSH agent for GitHub (`SSH_AUTH_SOCK` set and an authorized key)
  registered with GitHub — SSH access requires a registered key for every
  repository, including public ones; there is no unauthenticated SSH access.
  Clones are shallow and cached per-repository/ref for the lifetime of the
  process, under a stable `/tmp/pi-scryer` root with a unique per-clone child
  directory; only the child directories created by this process are removed
  on graceful shutdown, and the stable root itself is left in place. A
  `/commit/<sha>` URL reuses this reader's cached clone if that exact SHA was
  already fetched; a different commit SHA (or repository) triggers a fresh
  shallow fetch of that SHA. Blob content is capped at 100,000 bytes before
  `offset` chunking; use the returned local path to read larger files. If
  cloning, authentication, or the git fetch fails for a recognized GitHub
  code URL, `web_read` throws — it never falls back to Exa
  for these URLs. Other `github.com` URLs (issues, pulls, profile pages, etc.)
  and all non-GitHub URLs are still fetched via Exa as described below.
- Non-GitHub-code URLs are fetched using Exa's provider-side retrieval.
- **Continuing long pages:** when a page's extracted text does not fit in one
  call, the response ends with a marker stating the current offset, the exact
  next offset, the total text length, and the call to make next, e.g.
  `web_read(url, offset: N)`. Pass that exact `N` back as `offset` to fetch
  the next chunk — do not compute your own offset. Offsets are exact
  positions into the previously returned page text; copy them verbatim. The
  final chunk has no continuation marker.
- Omitting `offset` (or passing `0`) always fetches the page fresh (via the
  GitHub reader or Exa, per the routing above), atomically replacing (or
  removing, if the fresh page fits in one call) that URL's cache entry.
- The extension caches up to 5 pages' continuation state in a private,
  per-process temp directory (not shared between agents or processes). A
  continuation call (`offset > 0`) reuses a cached entry only when it targets
  the same URL as a cached fetch; otherwise (a different URL, a corrupted or
  missing cache file, an evicted entry, or a fresh process) it re-fetches
  before applying the offset. The 6th distinct page evicts the
  least-recently-used cached entry; reading a cached entry refreshes it.
  Finishing a page (reaching its last chunk) removes its cache entry. The
  cache directory is cleaned up on graceful shutdown and is otherwise
  abandoned to OS temp-directory cleanup if the process crashes.
- No retry, and no direct local page fetch for non-GitHub-code URLs —
  retrieval for those is always performed via the Exa API.

### `web_search`

`web_search(query)` searches the web via Exa and returns up to 5 results as
Markdown. Every valid result has a source URL; a title and a short excerpt
(up to 500 characters) are included when Exa provides them. Malformed search
entries may be omitted, and the output reports the omitted count.

- Fixed result count (5) and excerpt length; no pagination or batching.
- Fixed 30s timeout, same credential and error handling as `web_read`.
- Does not fetch full page content — call `web_read` on a returned source URL
  to read the full page.
- No retry, no fallback, and no direct local fetch — retrieval is always
  performed via the Exa API.

## Development

```
npm install
npm run lint
npm run typecheck
npm test
```

## License

MIT
