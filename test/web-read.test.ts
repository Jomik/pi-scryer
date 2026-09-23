import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createIdentityTheme,
  execFileMock,
  getRegisteredTool,
  jsonResponse,
  noop,
  ORIGINAL_ENV,
  type RenderedText,
  renderText,
  SECRET_KEY,
  textResponse,
  type WebReadToolDetails,
} from "./harness";

type ExecFileCallback = (
  error: (Error & { stdout?: string; stderr?: string }) | null,
  stdout: string,
  stderr: string,
) => void;

const KEYCHAIN_KEY = "keychain-test-key";

describe("web_read extension", () => {
  beforeEach(() => {
    process.env.EXA_API_KEY = SECRET_KEY;
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.EXA_API_KEY;
    } else {
      process.env.EXA_API_KEY = ORIGINAL_ENV;
    }
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("registers a strict schema for web_read", () => {
    const tool = getRegisteredTool("web_read");

    expect(tool.name).toBe("web_read");
    expect(tool.parameters.required).toEqual(["url"]);
    expect(Object.keys(tool.parameters.properties)).toEqual(["url", "offset"]);
    expect(tool.parameters.additionalProperties).toBe(false);
  });

  it.each([[-1], [1.5], [-0.5]])("rejects invalid offset %j without calling fetch", async (offset) => {
    const tool = getRegisteredTool("web_read");
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      tool.execute("call-1", { url: "https://example.com/page", offset }, new AbortController().signal, noop, {}),
    ).rejects.toThrow("web_read: offset must be a non-negative integer");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["file:///tmp/x"],
    ["ftp://example.com"],
    ["relative"],
  ])("rejects invalid URL %s without calling fetch", async (url) => {
    const tool = getRegisteredTool("web_read");
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(tool.execute("call-1", { url }, new AbortController().signal, noop, {})).rejects.toThrow(
      "web_read: url must be an absolute http or https URL",
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects with missing key error without calling fetch when Keychain and env are both unset", async () => {
    delete process.env.EXA_API_KEY;
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const tool = getRegisteredTool("web_read");
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      tool.execute("call-1", { url: "https://example.com/page" }, new AbortController().signal, noop, {}),
    ).rejects.toThrow("web_read: missing EXA_API_KEY; run /scryer login (macOS) or set EXA_API_KEY");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("succeeds using a Keychain-resolved key when EXA_API_KEY is unset", async () => {
    delete process.env.EXA_API_KEY;
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    execFileMock.mockImplementation((_file: string, _args: readonly string[], callback: ExecFileCallback) => {
      callback(null, `${KEYCHAIN_KEY}\n`, "");
    });
    const tool = getRegisteredTool("web_read");
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        results: [
          {
            title: "Example",
            url: "https://resolved.example/page",
            text: "Readable text",
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await tool.execute(
      "call-1",
      { url: "https://example.com/page" },
      new AbortController().signal,
      noop,
      {},
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    const headers = new Headers(init?.headers);
    expect(headers.get("x-api-key")).toBe(KEYCHAIN_KEY);
    expect(result.content[0].text).toContain("Readable text");
  });

  it("returns readable text on success and calls the Exa endpoint correctly", async () => {
    const tool = getRegisteredTool("web_read");
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        results: [
          {
            title: "Example",
            url: "https://resolved.example/page",
            text: "Readable text",
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await tool.execute(
      "call-1",
      { url: "https://example.com/page" },
      new AbortController().signal,
      noop,
      {},
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe("https://api.exa.ai/contents");
    expect(init).toBeDefined();
    expect(init?.method).toBe("POST");
    expect(init?.signal).toBeDefined();

    const headers = new Headers(init?.headers);
    expect(headers.get("x-api-key")).toBe(SECRET_KEY);
    expect(headers.get("content-type")).toBe("application/json");

    const body = JSON.parse(init?.body as string) as unknown;
    expect(body).toEqual({ urls: ["https://example.com/page"], text: true });

    const text = result.content[0].text;
    expect(text).toContain("Example");
    expect(text).toContain("https://resolved.example/page");
    expect(text).toContain("Readable text");
    expect(text).not.toContain(SECRET_KEY);
    expect(result.details).toEqual({
      title: "Example",
      source: "https://resolved.example/page",
      truncated: false,
      offset: 0,
      totalLength: "Readable text".length,
    });
  });

  it("omits the title heading when the provider returns no title", async () => {
    const tool = getRegisteredTool("web_read");
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        results: [
          {
            url: "https://resolved.example/page",
            text: "Readable text",
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await tool.execute(
      "call-1",
      { url: "https://example.com/page" },
      new AbortController().signal,
      noop,
      {},
    );

    const text = result.content[0].text;
    expect(text.startsWith("Source: https://resolved.example/page")).toBe(true);
    expect(text).not.toContain("# https://resolved.example/page");
    expect(text).toContain("Readable text");
  });

  it.each([
    [401, "invalid API key"],
    [402, "quota exceeded"],
    [429, "rate limited"],
  ])("maps HTTP %d to expected error message", async (status, expected) => {
    const tool = getRegisteredTool("web_read");
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ error: `secret leaked: ${SECRET_KEY}` }, status));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      tool.execute("call-1", { url: "https://example.com/page" }, new AbortController().signal, noop, {}),
    ).rejects.toThrow(expected);

    try {
      await tool.execute("call-1", { url: "https://example.com/page" }, new AbortController().signal, noop, {});
    } catch (err) {
      expect(String(err)).not.toContain(SECRET_KEY);
    }
  });

  it("reports malformed JSON responses", async () => {
    const tool = getRegisteredTool("web_read");
    const fetchMock = vi.fn<typeof fetch>(async () => textResponse("not json"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      tool.execute("call-1", { url: "https://example.com/page" }, new AbortController().signal, noop, {}),
    ).rejects.toThrow("malformed JSON");
  });

  it("reports status errors with only the status message, hiding the key", async () => {
    const tool = getRegisteredTool("web_read");
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        statuses: [
          {
            status: "error",
            error: { tag: "CRAWL_TIMEOUT", message: SECRET_KEY },
          },
        ],
        results: [],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    let caught: unknown;
    try {
      await tool.execute("call-1", { url: "https://example.com/page" }, new AbortController().signal, noop, {});
    } catch (err) {
      caught = err;
    }

    expect(String(caught)).toContain("Exa could not retrieve this URL");
    expect(String(caught)).not.toContain(SECRET_KEY);
  });

  it("reports when there are no results", async () => {
    const tool = getRegisteredTool("web_read");
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ results: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      tool.execute("call-1", { url: "https://example.com/page" }, new AbortController().signal, noop, {}),
    ).rejects.toThrow("no content returned");
  });

  it("reports whitespace-only text", async () => {
    const tool = getRegisteredTool("web_read");
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        results: [{ title: "Example", url: "https://resolved.example/page", text: "   \n\t  " }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      tool.execute("call-1", { url: "https://example.com/page" }, new AbortController().signal, noop, {}),
    ).rejects.toThrow("empty text");
  });

  it("propagates caller cancellation", async () => {
    const tool = getRegisteredTool("web_read");
    const controller = new AbortController();
    const fetchMock = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
          }
          signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const promise = tool.execute("call-1", { url: "https://example.com/page" }, controller.signal, noop, {});
    const assertion = expect(promise).rejects.toThrow("web_read: request cancelled");
    controller.abort();
    await assertion;
  });

  it("times out when the request takes too long", async () => {
    const tool = getRegisteredTool("web_read");
    const timeoutController = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
    let resolveFetchStarted: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      resolveFetchStarted = resolve;
    });
    const fetchMock = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          resolveFetchStarted();
          if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
          }
          signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const promise = tool.execute("call-1", { url: "https://example.com/page" }, new AbortController().signal, noop, {});
    const assertion = expect(promise).rejects.toThrow("web_read: request timed out");
    await fetchStarted;
    expect(timeoutSpy).toHaveBeenCalledWith(30_000);
    timeoutController.abort();
    await assertion;
  });

  it("propagates caller cancellation during JSON body parsing", async () => {
    const tool = getRegisteredTool("web_read");
    const controller = new AbortController();
    let resolveJsonStarted: () => void;
    const jsonStarted = new Promise<void>((resolve) => {
      resolveJsonStarted = resolve;
    });
    const fetchMock = vi.fn<typeof fetch>(async () => {
      const response = {
        ok: true,
        status: 200,
        json: () => {
          resolveJsonStarted();
          return new Promise<unknown>((_resolve, reject) => {
            controller.signal.addEventListener("abort", () => {
              reject(new DOMException("Aborted", "AbortError"));
            });
          });
        },
      } as unknown as Response;
      return response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const promise = tool.execute("call-1", { url: "https://example.com/page" }, controller.signal, noop, {});
    const assertion = expect(promise).rejects.toThrow("web_read: request cancelled");
    await jsonStarted;
    controller.abort();
    await assertion;
  });

  it("times out during JSON body parsing", async () => {
    const tool = getRegisteredTool("web_read");
    const timeoutController = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
    let resolveJsonStarted: () => void;
    const jsonStarted = new Promise<void>((resolve) => {
      resolveJsonStarted = resolve;
    });
    const fetchMock = vi.fn<typeof fetch>(async () => {
      const response = {
        ok: true,
        status: 200,
        json: () => {
          resolveJsonStarted();
          return new Promise<unknown>((_resolve, reject) => {
            timeoutController.signal.addEventListener("abort", () => {
              reject(new DOMException("Aborted", "AbortError"));
            });
          });
        },
      } as unknown as Response;
      return response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const promise = tool.execute("call-1", { url: "https://example.com/page" }, new AbortController().signal, noop, {});
    const assertion = expect(promise).rejects.toThrow("web_read: request timed out");
    await jsonStarted;
    expect(timeoutSpy).toHaveBeenCalledWith(30_000);
    timeoutController.abort();
    await assertion;
  });

  it("truncates oversized text with a source header and continuation marker", async () => {
    const tool = getRegisteredTool("web_read");
    const longText = Array.from({ length: Math.ceil((DEFAULT_MAX_BYTES + 1000) / 100) }, () => "x".repeat(99)).join(
      "\n",
    );
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        results: [
          {
            title: "Example",
            url: "https://resolved.example/page",
            text: longText,
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await tool.execute(
      "call-1",
      { url: "https://example.com/page" },
      new AbortController().signal,
      noop,
      {},
    );

    const text = result.content[0].text;
    const sourceIndex = text.indexOf("https://resolved.example/page");
    const markerIndex = text.indexOf("Continue with web_read(url, offset:");

    expect(sourceIndex).toBeGreaterThanOrEqual(0);
    expect(sourceIndex).toBeLessThan(200);
    expect(markerIndex).toBeGreaterThanOrEqual(0);
    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
    expect(new TextEncoder().encode(text).byteLength).toBeLessThan(new TextEncoder().encode(longText).byteLength);
    expect(text).not.toContain(SECRET_KEY);

    const details = result.details as WebReadToolDetails;
    expect(details.truncated).toBe(true);
    expect(details.offset).toBe(0);
    expect(details.totalLength).toBe(longText.length);
    expect(details.nextOffset).toBeGreaterThan(0);
    expect(details.nextOffset).toBeLessThan(longText.length);
  });

  it("rejects an offset at or beyond the end of the page content", async () => {
    const tool = getRegisteredTool("web_read");
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ results: [{ title: "Example", url: "https://resolved.example/page", text: "0123456789" }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      tool.execute("call-1", { url: "https://example.com/page", offset: 10 }, new AbortController().signal, noop, {}),
    ).rejects.toThrow("web_read: offset is at or beyond the end of the page content");

    await expect(
      tool.execute("call-1", { url: "https://example.com/page", offset: 20 }, new AbortController().signal, noop, {}),
    ).rejects.toThrow("web_read: offset is at or beyond the end of the page content");
  });

  it("reconstructs unicode content across a chunk boundary without corruption", async () => {
    const tool = getRegisteredTool("web_read");
    const emojiLine = "emoji line \u{1F600}\u{1F389}\u{1F44D} with surrogate pairs";
    const lines: string[] = [];
    for (let i = 0; i < 2500; i++) {
      lines.push(i === 1200 ? emojiLine : `line ${i}`);
    }
    const longText = lines.join("\n");
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ results: [{ title: "Example", url: "https://resolved.example/page", text: longText }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const header = "# Example\nSource: https://resolved.example/page\n\n";
    let offset: number | undefined;
    let reconstructed = "";
    for (let iterations = 0; ; iterations++) {
      if (iterations > 20) {
        throw new Error("too many iterations");
      }
      const params: Record<string, unknown> = { url: "https://example.com/page" };
      if (offset !== undefined) {
        params.offset = offset;
      }
      const result = await tool.execute("call-1", params, new AbortController().signal, noop, {});
      const text = result.content[0].text;
      expect(text).not.toContain("\uFFFD");
      const markerIndex = text.indexOf("\n\n[Showing offsets");
      const body = markerIndex >= 0 ? text.slice(header.length, markerIndex) : text.slice(header.length);
      reconstructed += body;
      const details = result.details as WebReadToolDetails;
      if (!details.truncated) {
        break;
      }
      offset = details.nextOffset;
    }

    expect(reconstructed).toBe(longText);
    expect(reconstructed).toContain(emojiLine);
  });

  it("keeps every returned chunk, including header and marker, within the byte and line limits", async () => {
    const tool = getRegisteredTool("web_read");
    const longText = Array.from({ length: 5000 }, (_, i) => `line ${i} with some extra padding text`).join("\n");
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ results: [{ title: "Example", url: "https://resolved.example/page", text: longText }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    let offset: number | undefined;
    for (let iterations = 0; ; iterations++) {
      if (iterations > 20) {
        throw new Error("too many iterations");
      }
      const params: Record<string, unknown> = { url: "https://example.com/page" };
      if (offset !== undefined) {
        params.offset = offset;
      }
      const result = await tool.execute("call-1", params, new AbortController().signal, noop, {});
      const text = result.content[0].text;
      expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
      expect(text.split("\n").length).toBeLessThanOrEqual(DEFAULT_MAX_LINES);
      const details = result.details as WebReadToolDetails;
      if (!details.truncated) {
        break;
      }
      offset = details.nextOffset;
    }
  });

  it("chunks a large single-line unicode page via byte-safe prefixes, always making progress", async () => {
    const tool = getRegisteredTool("web_read");
    const segment = "abcdefghij\u{1F600}\u{1F389}\u{1F44D}klmnopqrst";
    const segmentBytes = Buffer.byteLength(segment, "utf-8");
    const repeatCount = Math.ceil((DEFAULT_MAX_BYTES * 2) / segmentBytes);
    const longText = segment.repeat(repeatCount);
    expect(Buffer.byteLength(longText, "utf-8")).toBeGreaterThan(DEFAULT_MAX_BYTES);
    expect(longText).not.toContain("\n");

    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ results: [{ title: "Example", url: "https://resolved.example/page", text: longText }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const header = "# Example\nSource: https://resolved.example/page\n\n";
    let offset: number | undefined;
    let previousOffset = -1;
    let reconstructed = "";
    for (let iterations = 0; ; iterations++) {
      if (iterations > 50) {
        throw new Error("too many iterations");
      }
      const params: Record<string, unknown> = { url: "https://example.com/page" };
      if (offset !== undefined) {
        params.offset = offset;
      }
      const result = await tool.execute("call-1", params, new AbortController().signal, noop, {});
      const text = result.content[0].text;
      expect(text).not.toContain("\uFFFD");
      expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
      expect(text.split("\n").length).toBeLessThanOrEqual(DEFAULT_MAX_LINES);

      const markerIndex = text.indexOf("\n\n[Showing offsets");
      const body = markerIndex >= 0 ? text.slice(header.length, markerIndex) : text.slice(header.length);
      reconstructed += body;

      const details = result.details as WebReadToolDetails;
      const currentOffset = offset ?? 0;
      expect(details.offset).toBe(currentOffset);
      if (!details.truncated) {
        break;
      }
      expect(details.nextOffset).toBeGreaterThan(currentOffset);
      expect(details.nextOffset).toBeGreaterThan(previousOffset);
      previousOffset = details.nextOffset as number;
      offset = details.nextOffset;
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(reconstructed).toBe(longText);
  });

  it("normalizes and caps an oversized provider title before output/cache", async () => {
    const tool = getRegisteredTool("web_read");
    const rawTitle = `Title\nwith  extra   whitespace ${"T".repeat(60_000)}`;
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        results: [{ title: rawTitle, url: "https://resolved.example/page", text: "Short body text" }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await tool.execute(
      "call-1",
      { url: "https://example.com/page" },
      new AbortController().signal,
      noop,
      {},
    );
    const text = result.content[0].text;
    const details = result.details as WebReadToolDetails;

    expect(details.title).toBeDefined();
    expect(details.title?.length).toBeLessThanOrEqual(200);
    expect(details.title).not.toContain("\n");
    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
    expect(text.split("\n").length).toBeLessThanOrEqual(DEFAULT_MAX_LINES);
  });

  it("rejects an oversized resolved result URL with a fixed error", async () => {
    const tool = getRegisteredTool("web_read");
    const oversizedUrl = `https://resolved.example/${"a".repeat(2048)}`;
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        results: [{ title: "Example", url: oversizedUrl, text: "Some body text" }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      tool.execute("call-1", { url: "https://example.com/page" }, new AbortController().signal, noop, {}),
    ).rejects.toThrow("web_read: content provider returned an oversized result URL");
  });
});

describe("web_read rendering", () => {
  const theme = createIdentityTheme();

  it("renderCall bounds a long URL to a single line preview when collapsed", () => {
    const tool = getRegisteredTool("web_read");
    const longUrl = `https://example.com/${"a".repeat(200)}`;
    const component = tool.renderCall?.({ url: longUrl }, theme, { expanded: false });
    expect(component).toBeDefined();
    const rendered = renderText(component as RenderedText, 60);
    const lines = rendered.split("\n");
    expect(lines.length).toBe(1);
    expect(visibleWidth(lines[0])).toBeLessThanOrEqual(60);
  });

  it("renderCall shows the full URL when expanded", () => {
    const tool = getRegisteredTool("web_read");
    const longUrl = `https://example.com/${"a".repeat(200)}`;
    const component = tool.renderCall?.({ url: longUrl }, theme, { expanded: true });
    const rendered = renderText(component as RenderedText);
    expect(rendered).toContain(longUrl);
  });

  it("renderCall includes the offset when nonzero, collapsed and expanded", () => {
    const tool = getRegisteredTool("web_read");
    const url = "https://example.com/page";

    const expandedZero = tool.renderCall?.({ url, offset: 0 }, theme, { expanded: true });
    expect(renderText(expandedZero as RenderedText)).not.toContain("offset");

    const expanded = tool.renderCall?.({ url, offset: 4096 }, theme, { expanded: true });
    expect(renderText(expanded as RenderedText)).toContain("4096");

    const collapsed = tool.renderCall?.({ url, offset: 4096 }, theme, { expanded: false });
    expect(renderText(collapsed as RenderedText)).toContain("4096");
  });

  it("renderResult shows a compact partial state", () => {
    const tool = getRegisteredTool("web_read");
    const component = tool.renderResult?.(
      { content: [{ type: "text", text: "" }], details: undefined },
      { expanded: false, isPartial: true },
      theme,
      { isError: false },
    );
    expect(renderText(component as RenderedText)).toBe("Reading…");
  });

  it("renderResult shows a compact failed state without echoing result body", () => {
    const tool = getRegisteredTool("web_read");
    const component = tool.renderResult?.(
      { content: [{ type: "text", text: `secret leaked: ${SECRET_KEY}` }], details: undefined },
      { expanded: false, isPartial: false },
      theme,
      { isError: true },
    );
    const rendered = renderText(component as RenderedText);
    expect(rendered).toBe("failed");
    expect(rendered).not.toContain(SECRET_KEY);
  });

  it("renderResult expanded returns the complete unmodified content text", () => {
    const tool = getRegisteredTool("web_read");
    const fullText = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const component = tool.renderResult?.(
      {
        content: [{ type: "text", text: fullText }],
        details: { source: "https://example.com", truncated: false, offset: 0, totalLength: fullText.length },
      },
      { expanded: true, isPartial: false },
      theme,
      { isError: false },
    );
    expect(renderText(component as RenderedText)).toBe(fullText);
  });

  it("renderResult collapsed shows title and source when a title is known", () => {
    const tool = getRegisteredTool("web_read");
    const component = tool.renderResult?.(
      {
        content: [{ type: "text", text: "body" }],
        details: {
          title: "Example Title",
          source: "https://example.com/page",
          truncated: false,
          offset: 0,
          totalLength: 4,
        },
      },
      { expanded: false, isPartial: false },
      theme,
      { isError: false },
    );
    const rendered = renderText(component as RenderedText, 60);
    const lines = rendered.split("\n");
    expect(lines.length).toBe(1);
    expect(visibleWidth(lines[0])).toBeLessThanOrEqual(60);
    expect(rendered).toContain("Example Title");
    expect(rendered).toContain("https://example.com/page");
    expect(rendered).not.toContain("more");
  });

  it("renderResult collapsed shows only the source when the title is unknown, without inventing one", () => {
    const tool = getRegisteredTool("web_read");
    const component = tool.renderResult?.(
      {
        content: [{ type: "text", text: "body" }],
        details: { source: "https://example.com/page", truncated: false, offset: 0, totalLength: 4 },
      },
      { expanded: false, isPartial: false },
      theme,
      { isError: false },
    );
    const rendered = renderText(component as RenderedText);
    expect(rendered).toContain("https://example.com/page");
    expect(rendered).not.toMatch(/^Example/);
  });

  it("renderResult collapsed indicates a bounded continuation with the next offset, without leaking cached content", () => {
    const tool = getRegisteredTool("web_read");
    const component = tool.renderResult?.(
      {
        content: [{ type: "text", text: "body" }],
        details: {
          source: "https://example.com/page",
          truncated: true,
          offset: 0,
          nextOffset: 12345,
          totalLength: 99999,
        },
      },
      { expanded: false, isPartial: false },
      theme,
      { isError: false },
    );
    const rendered = renderText(component as RenderedText);
    expect(rendered).toContain("more");
    expect(rendered).toContain("12345");
    expect(rendered).not.toContain("body");
  });
});
