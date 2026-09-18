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

`web_read(url)` fetches a URL's content using Exa's provider-side retrieval and
returns the title, resolved source, and extracted text.

- HTTP(S) URLs only.
- Fixed 30s timeout.
- Output limited to 50KB or 2000 lines, whichever is hit first.
- No retry, no fallback, and no direct local page fetch — retrieval is always
  performed via the Exa API.

### `web_search`

`web_search(query)` searches the web via Exa and returns up to 5 results as
Markdown, each with a title, source URL, and a short excerpt (up to 500
characters).

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
