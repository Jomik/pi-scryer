# pi-scryer

Minimal Exa web access for [pi](https://github.com/earendil-works/pi). Currently provides
`web_read` only.

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

Planned, not yet implemented.

## Development

```
npm install
npm run lint
npm run typecheck
npm test
```

## License

MIT
