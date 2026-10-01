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
keyed routes: Exa REST and Tavily REST.

On macOS, run `/scryer login exa` or `/scryer login tavily` in the
interactive Pi TUI. A native dialog hides the entered key and stores it in the
macOS Keychain under the fixed service `pi-scryer`, with provider-specific
accounts `exa-api-key` and `tavily-api-key`. This is the recommended path:
the key is stored securely by the OS, never in a project, session, or cache file.

On headless macOS or any other platform, configure environment variables instead
(for either or both providers):

```
export EXA_API_KEY=...
export TAVILY_API_KEY=...
```

Login outside the interactive macOS TUI gives guidance to set the selected
provider's environment variable rather than opening a prompt.

Credential commands:

- `/scryer login exa` or `/scryer login tavily` — stores the selected
  provider's key in Keychain.
- `/scryer logout exa` or `/scryer logout tavily` — removes only the
  selected Keychain account (macOS only, idempotent). It never changes either
  environment variable or the other provider's account; a configured environment
  fallback remains available. On non-macOS platforms, it gives guidance to unset
  the selected environment variable.
- `/scryer status` — reports both Exa and Tavily credential sources:
  `Keychain`, `environment` (with the variable name), or `missing`, without
  reading Keychain values or revealing keys. It does not check balance or route
  health.
- Bare `/scryer` reports both sources and usage. The provider is **required**
  for login and logout: bare `/scryer login` or `/scryer logout` only shows
  usage; neither defaults to Exa. Anonymous and unknown provider names are
  rejected.
- Autocomplete offers only the subcommands `login`, `logout`, `status` and,
  after login/logout, registered keyed provider names (`exa`, `tavily`).

Precedence for each provider: on macOS, Keychain is checked first; if it is
missing, empty, or inaccessible, the trimmed `EXA_API_KEY` or `TAVILY_API_KEY`
environment variable is used instead. On non-macOS platforms, only the
environment is consulted. Keys are never shown in notifications or stored or
cached in any project, session, or cache file. Anonymous requests never send a
configured API key.

Both keyed provider factories resolve credentials lazily on the first hosted
search or read, not at extension activation; Tavily no longer captures its key
eagerly at activation. The resulting provider registry is cached for the Pi
process. GitHub-only reads do not load it or probe Exa/Tavily credentials.
Credential changes (including login and logout) require restarting Pi to refresh
active routes; successful login/logout notices include this reminder. Restarting
also resets route availability.

## Provider routing

Four standalone providers are tracked independently:

- `exa` — keyed Exa REST.
- `exa-anon` — anonymous Exa MCP.
- `tavily` — keyed Tavily REST.
- `tavily-anon` — keyless Tavily REST (anonymous).

Each provider is one route. Each fresh `web_search` or non-GitHub `web_read`
randomly starts with one eligible anonymous route, then tries the other eligible
anonymous route if needed. Only if neither
returns a usable result does it randomly start with an eligible configured
keyed route, then try the other eligible keyed route if needed. Routes without
a configured key, disabled routes, and rate-limited routes still waiting for
their retry time are omitted. Attempts are sequential, not parallel queries.
Successful output identifies the provider and access mode as `Exa (keyed)`,
`Exa-anon (anonymous)`, `Tavily (keyed)`, or `Tavily-anon (anonymous)`;
`web_read` continuation chunks retain the original provider and mode. Empty
search results may prompt another route; if all routes return no matches, the result
is "No search results found."

Quota exhaustion or invalid credentials disable only the affected route until
process restart. Rate limits skip a route until its next eligible time, using
a valid positive HTTP `Retry-After` delay when present; for Tavily keyless
responses, `retry_after_seconds` in the error body is used if the header is
absent or invalid. Otherwise the cooldown is 30 seconds. Each route's next
eligible time is held in process memory; there is no balance API check or
persistent quota tracking. Other transient failures fall through to the next route for
that request and can be retried on a later request; a failed route is not
retried within the same request. If no route succeeds, the tool reports a
sanitized failure instead of returning partial content. Neither `/scryer status`
nor a successful request reveals remaining free-tier balance: this extension
cannot guarantee free-tier-only billing. Set provider-side spending caps or
disable overages if a hard spending limit is required.

## Tools

### `web_read`

`web_read(url, offset?)` fetches a URL's content and returns the resolved
source and extracted text; the title is included only when available.

- HTTP(S) URLs only.
- Fixed 30s timeout.
- Output limited to 50KB or 2000 lines per call, whichever is hit first.
- **GitHub code URLs:** repo root, `/tree/<ref>[/path]`, `/blob/<ref>/path`,
  `/commit/<sha>`, and `/raw/<ref>/path` URLs on `github.com` (also
  `www.github.com`) and `raw.githubusercontent.com/OWNER/REPO/<ref>/path`
  are read directly by shallow-cloning the repository over HTTPS via the `gh`
  CLI (`gh repo clone
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
Providers may silently discard malformed URLs before formatting. The reported
`omitted` count covers only entries rejected during final formatting.

- Fixed result count (5) and excerpt length; no pagination or batching.
- Each hosted request has a 30s timeout; route fallback follows the rules above.
- Does not fetch full page content — call `web_read` on a returned source URL
  to read the full page. No direct local fetch of arbitrary websites.

## Development

Transport implementations live in `src/providers/{exa,exa-anon,tavily}.ts`;
`src/providers/registry.ts` explicitly assembles the available provider entries.
Tavily's keyed and anonymous providers share the same REST code. In
`src/provider-routing.ts`, `WebProvider` extends `ProviderRoute` (`search` and
`read`) with `name: string` and `mode: "anonymous" | "keyed"`. Shared content
types and helpers live in `src/web-content.ts`. The router alone chooses the
provider; neither tool exposes a provider argument to the agent.

The single static credential metadata list in
`src/providers/credential-providers.ts` defines registered keyed names,
environment variables, and Keychain accounts. It drives credential commands
(including status and autocomplete) and the shared `resolveProviderApiKey`
resolver used by both keyed provider factories. The registry loads both factories
lazily on the first hosted call.

Vitest loads the fail-closed guards in `test/setup.ts` before modules under test:
unexpected subprocess or network calls fail rather than invoking real external
boundaries. `AGENTS.md` requires hermetic, noninteractive tests: no real OS
prompts, Keychain or credential-store access, `osascript`, `security`, `gh`,
`git`, or network calls. Mock external boundaries before loading source modules;
use deterministic fixtures for prompts, login, and cancellation.

```
npm install
npm run lint
npm run typecheck
npm test
```

## License

MIT
