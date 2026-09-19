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

Requires an Exa API key:

```
export EXA_API_KEY=...
```

## Tools

### `web_read`

`web_read(url, offset?)` fetches a URL's content using Exa's provider-side
retrieval and returns the resolved source and extracted text; the title is
included only when Exa provides one.

- HTTP(S) URLs only.
- Fixed 30s timeout.
- Output limited to 50KB or 2000 lines per call, whichever is hit first.
- **Continuing long pages:** when a page's extracted text does not fit in one
  call, the response ends with a marker stating the current offset, the exact
  next offset, the total text length, and the call to make next, e.g.
  `web_read(url, offset: N)`. Pass that exact `N` back as `offset` to fetch
  the next chunk — do not compute your own offset. The final chunk has no
  continuation marker.
- Omitting `offset` (or passing `0`) always fetches the page fresh from Exa.
- The extension keeps a single process-local cache entry of the most
  recently fetched page. A continuation call (`offset > 0`) reuses that cache
  only when it targets the same URL as the cached fetch; otherwise (a
  different URL, an evicted entry, or a fresh process) it re-fetches via Exa
  before applying the offset.
- No retry, no fallback, and no direct local page fetch — retrieval is always
  performed via the Exa API.

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
