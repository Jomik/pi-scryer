import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import activate from "../src/index";

interface WebReadToolDetails {
  title?: string;
  source: string;
  truncated: boolean;
  offset: number;
  nextOffset?: number;
  totalLength: number;
}

interface WebSearchToolDetails {
  resultCount: number;
  omitted: number;
  truncated: boolean;
}

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  details: WebReadToolDetails | WebSearchToolDetails | undefined;
}

interface RenderedText {
  render: (width: number) => string[];
}

interface FakeTheme {
  fg: (color: string, text: string) => string;
  bold: (text: string) => string;
}

interface ToolCallRenderContext {
  expanded: boolean;
}

interface ToolResultRenderOptions {
  expanded: boolean;
  isPartial: boolean;
}

interface ToolResultRenderContext {
  isError: boolean;
}

function createIdentityTheme(): FakeTheme {
  return {
    fg: (_color, text) => text,
    bold: (text) => text,
  };
}

const LARGE_RENDER_WIDTH = 10_000;

function renderText(component: RenderedText, width: number = LARGE_RENDER_WIDTH): string {
  return component
    .render(width)
    .map((line) => line.trimEnd())
    .join("\n");
}

interface ToolSchema {
  type: string;
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: boolean;
}

interface RegisteredTool {
  name: string;
  parameters: ToolSchema;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: (...args: unknown[]) => void,
    ctx: unknown,
  ) => Promise<ToolResult>;
  renderCall?: (args: Record<string, unknown>, theme: FakeTheme, context: ToolCallRenderContext) => RenderedText;
  renderResult?: (
    result: ToolResult,
    options: ToolResultRenderOptions,
    theme: FakeTheme,
    context: ToolResultRenderContext,
  ) => RenderedText;
}

const ORIGINAL_ENV = process.env.EXA_API_KEY;
const SECRET_KEY = "secret-test-key";

function getRegisteredTools(): RegisteredTool[] {
  const registerTool = vi.fn<(tool: RegisteredTool) => void>();
  const api = { registerTool } as unknown as ExtensionAPI;
  activate(api);
  expect(registerTool).toHaveBeenCalledTimes(2);
  return registerTool.mock.calls.map((call) => call[0]);
}

function getRegisteredTool(name: string): RegisteredTool {
  const tool = getRegisteredTools().find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`tool ${name} was not registered`);
  }
  return tool;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status });
}

function noop(): void {}

describe("extension registration", () => {
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

  it("registers exactly web_read and web_search", () => {
    const tools = getRegisteredTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(["web_read", "web_search"]);
  });
});

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

  it("rejects with missing key error without calling fetch", async () => {
    delete process.env.EXA_API_KEY;
    const tool = getRegisteredTool("web_read");
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      tool.execute("call-1", { url: "https://example.com/page" }, new AbortController().signal, noop, {}),
    ).rejects.toThrow("web_read: missing EXA_API_KEY");

    expect(fetchMock).not.toHaveBeenCalled();
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

    const promise = tool.execute("call-1", { url: "https://example.com/page" }, new AbortController().signal, noop, {});
    const assertion = expect(promise).rejects.toThrow("web_read: request timed out");
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
    expect(timeoutSpy).toHaveBeenCalledWith(30_000);
    await jsonStarted;
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

  it("continues a long page via the exact returned nextOffset using the cache, without re-fetching", async () => {
    const tool = getRegisteredTool("web_read");
    const longText = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        results: [{ title: "Example", url: "https://resolved.example/page", text: longText }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const chunks: WebReadToolDetails[] = [];
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
      const details = result.details as WebReadToolDetails;
      chunks.push(details);
      if (!details.truncated) {
        break;
      }
      offset = details.nextOffset;
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[chunks.length - 1].truncated).toBe(false);
    expect(chunks[chunks.length - 1].nextOffset).toBeUndefined();

    let expectedOffset = 0;
    for (const details of chunks) {
      expect(details.offset).toBe(expectedOffset);
      expect(details.totalLength).toBe(longText.length);
      expectedOffset = details.nextOffset ?? longText.length;
    }
    expect(expectedOffset).toBe(longText.length);
  });

  it("re-fetches fresh content whenever offset is omitted or 0, even with a matching cache", async () => {
    const tool = getRegisteredTool("web_read");
    const longText = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ results: [{ title: "Example", url: "https://resolved.example/page", text: longText }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = await tool.execute(
      "call-1",
      { url: "https://example.com/page" },
      new AbortController().signal,
      noop,
      {},
    );
    expect((first.details as WebReadToolDetails).truncated).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await tool.execute(
      "call-1",
      { url: "https://example.com/page", offset: 0 },
      new AbortController().signal,
      noop,
      {},
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await tool.execute("call-1", { url: "https://example.com/page" }, new AbortController().signal, noop, {});
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("misses the cache and re-fetches when continuing a different URL", async () => {
    const tool = getRegisteredTool("web_read");
    const longTextA = Array.from({ length: 5000 }, (_, i) => `a-line ${i}`).join("\n");
    const longTextB = Array.from({ length: 5000 }, (_, i) => `b-line ${i}`).join("\n");
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse((init?.body as string) ?? "{}") as { urls: string[] };
      const url = body.urls[0];
      const text = url.includes("page-a") ? longTextA : longTextB;
      return jsonResponse({ results: [{ title: "Example", url, text }] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const firstA = await tool.execute(
      "call-1",
      { url: "https://example.com/page-a" },
      new AbortController().signal,
      noop,
      {},
    );
    const detailsA = firstA.details as WebReadToolDetails;
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await tool.execute(
      "call-1",
      { url: "https://example.com/page-b", offset: detailsA.nextOffset },
      new AbortController().signal,
      noop,
      {},
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("starts with an empty cache in a new extension instance and re-fetches", async () => {
    const longText = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ results: [{ title: "Example", url: "https://resolved.example/page", text: longText }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const toolA = getRegisteredTool("web_read");
    const firstA = await toolA.execute(
      "call-1",
      { url: "https://example.com/page" },
      new AbortController().signal,
      noop,
      {},
    );
    const detailsA = firstA.details as WebReadToolDetails;
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const toolB = getRegisteredTool("web_read");
    await toolB.execute(
      "call-1",
      { url: "https://example.com/page", offset: detailsA.nextOffset },
      new AbortController().signal,
      noop,
      {},
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("replaces the one-entry cache on a fresh read, evicting the prior continuation", async () => {
    const tool = getRegisteredTool("web_read");
    const longTextA = Array.from({ length: 5000 }, (_, i) => `a-line ${i}`).join("\n");
    const longTextB = Array.from({ length: 5000 }, (_, i) => `b-line ${i}`).join("\n");
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse((init?.body as string) ?? "{}") as { urls: string[] };
      const url = body.urls[0];
      const text = url.includes("page-a") ? longTextA : longTextB;
      return jsonResponse({ results: [{ title: "Example", url, text }] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const firstA = await tool.execute(
      "call-1",
      { url: "https://example.com/page-a" },
      new AbortController().signal,
      noop,
      {},
    );
    const detailsA = firstA.details as WebReadToolDetails;
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await tool.execute("call-1", { url: "https://example.com/page-b" }, new AbortController().signal, noop, {});
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await tool.execute(
      "call-1",
      { url: "https://example.com/page-a", offset: detailsA.nextOffset },
      new AbortController().signal,
      noop,
      {},
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not cache a short, complete read", async () => {
    const tool = getRegisteredTool("web_read");
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ results: [{ title: "Example", url: "https://resolved.example/page", text: "short text" }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await tool.execute(
      "call-1",
      { url: "https://example.com/page" },
      new AbortController().signal,
      noop,
      {},
    );
    const details = result.details as WebReadToolDetails;
    expect(details.truncated).toBe(false);
    expect(details.nextOffset).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await expect(
      tool.execute("call-1", { url: "https://example.com/page", offset: 100 }, new AbortController().signal, noop, {}),
    ).rejects.toThrow("web_read: offset is at or beyond the end of the page content");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not poison the cache when an unrelated continuation fetch fails", async () => {
    const tool = getRegisteredTool("web_read");
    const longTextA = Array.from({ length: 5000 }, (_, i) => `a-line ${i}`).join("\n");
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse((init?.body as string) ?? "{}") as { urls: string[] };
      const url = body.urls[0];
      if (url.includes("page-a")) {
        return jsonResponse({ results: [{ title: "Example", url, text: longTextA }] });
      }
      return jsonResponse({ error: "boom" }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);

    const firstA = await tool.execute(
      "call-1",
      { url: "https://example.com/page-a" },
      new AbortController().signal,
      noop,
      {},
    );
    const detailsA = firstA.details as WebReadToolDetails;
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await expect(
      tool.execute(
        "call-1",
        { url: "https://example.com/page-failing", offset: detailsA.nextOffset },
        new AbortController().signal,
        noop,
        {},
      ),
    ).rejects.toThrow("request failed with status 500");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const continuedA = await tool.execute(
      "call-1",
      { url: "https://example.com/page-a", offset: detailsA.nextOffset },
      new AbortController().signal,
      noop,
      {},
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((continuedA.details as WebReadToolDetails).offset).toBe(detailsA.nextOffset);
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

describe("web_search extension", () => {
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

  it("registers a strict schema for web_search", () => {
    const tool = getRegisteredTool("web_search");

    expect(tool.name).toBe("web_search");
    expect(tool.parameters.required).toEqual(["query"]);
    expect(Object.keys(tool.parameters.properties)).toEqual(["query"]);
    expect(tool.parameters.additionalProperties).toBe(false);
  });

  it.each([["   "], [""]])("rejects whitespace query %j without calling fetch", async (query) => {
    const tool = getRegisteredTool("web_search");
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(tool.execute("call-1", { query }, new AbortController().signal, noop, {})).rejects.toThrow(
      "web_search: query must not be empty",
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects with missing key error without calling fetch", async () => {
    delete process.env.EXA_API_KEY;
    const tool = getRegisteredTool("web_search");
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      tool.execute("call-1", { query: "pi coding agent" }, new AbortController().signal, noop, {}),
    ).rejects.toThrow("web_search: missing EXA_API_KEY");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("calls the Exa search endpoint with the exact expected request", async () => {
    const tool = getRegisteredTool("web_search");
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        results: [{ title: "Example", url: "https://resolved.example/page", text: "Some excerpt" }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await tool.execute("call-1", { query: "  pi coding agent  " }, new AbortController().signal, noop, {});

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe("https://api.exa.ai/search");
    expect(init?.method).toBe("POST");
    expect(init?.signal).toBeDefined();

    const headers = new Headers(init?.headers);
    expect(headers.get("x-api-key")).toBe(SECRET_KEY);
    expect(headers.get("content-type")).toBe("application/json");

    const body = JSON.parse(init?.body as string) as unknown;
    expect(body).toEqual({
      query: "pi coding agent",
      numResults: 5,
      contents: { text: { maxCharacters: 500 } },
    });
  });

  it("returns Markdown with title, source, and excerpt", async () => {
    const tool = getRegisteredTool("web_search");
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        results: [{ title: "Example Title", url: "https://resolved.example/page", text: "Example excerpt" }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await tool.execute("call-1", { query: "example" }, new AbortController().signal, noop, {});
    const text = result.content[0].text;

    expect(text).toContain("Example Title");
    expect(text).toContain("Source: https://resolved.example/page");
    expect(text).toContain("Example excerpt");
    expect(text).not.toContain(SECRET_KEY);
    expect(result.details).toEqual({ resultCount: 1, omitted: 0, truncated: false });
  });

  it("normalizes a title containing newlines and a spoofed Source line into a single safe line", async () => {
    const tool = getRegisteredTool("web_search");
    const maliciousTitle = "Evil\nSource: https://attacker.example/fake\n1. Fake Result\tTitle";
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        results: [{ title: maliciousTitle, url: "https://resolved.example/page", text: "Example excerpt" }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await tool.execute("call-1", { query: "example" }, new AbortController().signal, noop, {});
    const text = result.content[0].text;

    expect(text).toContain("1. Evil Source: https://attacker.example/fake 1. Fake Result Title");
    expect(text).not.toContain("Evil\nSource:");
    const lines = text.split("\n");
    expect(lines.filter((line) => line.startsWith("Source:"))).toEqual(["Source: https://resolved.example/page"]);
    const sourceOccurrences = text.split("Source: https://resolved.example/page").length - 1;
    expect(sourceOccurrences).toBe(1);
  });

  it("caps output at five results even if the provider returns more", async () => {
    const tool = getRegisteredTool("web_search");
    const results = Array.from({ length: 8 }, (_, i) => ({
      title: `Result ${i}`,
      url: `https://example.com/${i}`,
    }));
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ results }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await tool.execute("call-1", { query: "example" }, new AbortController().signal, noop, {});
    const text = result.content[0].text;

    for (let i = 0; i < 5; i++) {
      expect(text).toContain(`https://example.com/${i}`);
    }
    for (let i = 5; i < 8; i++) {
      expect(text).not.toContain(`https://example.com/${i}`);
    }
  });

  it("reports a clear message when there are no results", async () => {
    const tool = getRegisteredTool("web_search");
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ results: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await tool.execute("call-1", { query: "example" }, new AbortController().signal, noop, {});
    expect(result.content[0].text).toBe("No search results found.");
  });

  it.each([
    [{ notResults: [] }],
    [{ results: "not-an-array" }],
    ["not-a-record"],
  ])("rejects malformed top-level responses %j", async (body) => {
    const tool = getRegisteredTool("web_search");
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(body));
    vi.stubGlobal("fetch", fetchMock);

    await expect(tool.execute("call-1", { query: "example" }, new AbortController().signal, noop, {})).rejects.toThrow(
      "malformed response from search provider",
    );
  });

  it("rejects when every result entry is invalid", async () => {
    const tool = getRegisteredTool("web_search");
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ results: [{ title: "No URL" }, { url: "not-a-url" }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(tool.execute("call-1", { query: "example" }, new AbortController().signal, noop, {})).rejects.toThrow(
      "malformed results from search provider",
    );
  });

  it("omits malformed entries and reports how many were omitted", async () => {
    const tool = getRegisteredTool("web_search");
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        results: [{ title: "Valid", url: "https://example.com/valid" }, { title: "No URL" }, { url: "not-a-url" }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await tool.execute("call-1", { query: "example" }, new AbortController().signal, noop, {});
    const text = result.content[0].text;

    expect(text).toContain("https://example.com/valid");
    expect(text).toContain("2 results omitted");
  });

  it("bounds titles and excerpts locally to their expected limits", async () => {
    const tool = getRegisteredTool("web_search");
    const longTitle = "T".repeat(300);
    const longExcerpt = "E".repeat(700);
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        results: [{ title: longTitle, url: "https://example.com/page", text: longExcerpt }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await tool.execute("call-1", { query: "example" }, new AbortController().signal, noop, {});
    const text = result.content[0].text;

    expect(text).toContain(`${"T".repeat(199)}…`);
    expect(text).not.toContain("T".repeat(200));
    expect(text).toContain("E".repeat(500));
    expect(text).not.toContain("E".repeat(501));
  });

  it("omits the title line when title is missing, and rejects URLs over 2048 chars", async () => {
    const tool = getRegisteredTool("web_search");
    const longUrl = `https://example.com/${"a".repeat(300)}`;
    const overlongUrl = `https://example.com/${"a".repeat(2048)}`;
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        results: [{ url: longUrl }, { title: "Too Long", url: overlongUrl }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await tool.execute("call-1", { query: "example" }, new AbortController().signal, noop, {});
    const text = result.content[0].text;

    expect(text.split("\n")[0]).toBe(`1. Source: ${longUrl}`);
    const sourceOccurrences = text.split(`Source: ${longUrl}`).length - 1;
    expect(sourceOccurrences).toBe(1);
    expect(text).not.toMatch(/^\d+\. https:\/\//m);
    expect(text).not.toContain(overlongUrl);
    expect(text).toContain("1 result omitted");
  });

  it.each([
    [401, "invalid API key"],
    [402, "quota exceeded"],
    [429, "rate limited"],
  ])("maps HTTP %d to expected error message without leaking the key", async (status, expected) => {
    const tool = getRegisteredTool("web_search");
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ error: `secret leaked: ${SECRET_KEY}` }, status));
    vi.stubGlobal("fetch", fetchMock);

    let caught: unknown;
    try {
      await tool.execute("call-1", { query: "example" }, new AbortController().signal, noop, {});
    } catch (err) {
      caught = err;
    }

    expect(String(caught)).toContain(expected);
    expect(String(caught)).not.toContain(SECRET_KEY);
  });

  it("propagates caller cancellation", async () => {
    const tool = getRegisteredTool("web_search");
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

    const promise = tool.execute("call-1", { query: "example" }, controller.signal, noop, {});
    const assertion = expect(promise).rejects.toThrow("web_search: request cancelled");
    controller.abort();
    await assertion;
  });

  it("times out after 30 seconds", async () => {
    const tool = getRegisteredTool("web_search");
    const timeoutController = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
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

    const promise = tool.execute("call-1", { query: "example" }, new AbortController().signal, noop, {});
    const assertion = expect(promise).rejects.toThrow("web_search: request timed out");
    expect(timeoutSpy).toHaveBeenCalledWith(30_000);
    timeoutController.abort();
    await assertion;
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

describe("web_search rendering", () => {
  const theme = createIdentityTheme();

  it("renderCall bounds a long query to a single line preview when collapsed", () => {
    const tool = getRegisteredTool("web_search");
    const longQuery = "q".repeat(200);
    const component = tool.renderCall?.({ query: longQuery }, theme, { expanded: false });
    const rendered = renderText(component as RenderedText, 60);
    const lines = rendered.split("\n");
    expect(lines.length).toBe(1);
    expect(visibleWidth(lines[0])).toBeLessThanOrEqual(60);
  });

  it("renderCall shows the full query when expanded", () => {
    const tool = getRegisteredTool("web_search");
    const longQuery = "q".repeat(200);
    const component = tool.renderCall?.({ query: longQuery }, theme, { expanded: true });
    const rendered = renderText(component as RenderedText);
    expect(rendered).toContain(longQuery);
  });

  it("renderResult shows a compact partial state", () => {
    const tool = getRegisteredTool("web_search");
    const component = tool.renderResult?.(
      { content: [{ type: "text", text: "" }], details: undefined },
      { expanded: false, isPartial: true },
      theme,
      { isError: false },
    );
    expect(renderText(component as RenderedText)).toBe("Searching…");
  });

  it("renderResult shows a compact failed state without echoing result body", () => {
    const tool = getRegisteredTool("web_search");
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
    const tool = getRegisteredTool("web_search");
    const fullText = Array.from({ length: 50 }, (_, i) => `1. Result ${i}\nSource: https://example.com/${i}`).join(
      "\n",
    );
    const component = tool.renderResult?.(
      { content: [{ type: "text", text: fullText }], details: { resultCount: 50, omitted: 0, truncated: false } },
      { expanded: true, isPartial: false },
      theme,
      { isError: false },
    );
    expect(renderText(component as RenderedText)).toBe(fullText);
  });

  it("renderResult collapsed shows only a result count, not titles/sources/excerpts", () => {
    const tool = getRegisteredTool("web_search");
    const bodyText = "1. Secret Title\nSource: https://example.com/secret\nSecret excerpt";
    const component = tool.renderResult?.(
      { content: [{ type: "text", text: bodyText }], details: { resultCount: 1, omitted: 0, truncated: false } },
      { expanded: false, isPartial: false },
      theme,
      { isError: false },
    );
    const rendered = renderText(component as RenderedText);
    expect(rendered).toContain("1 result");
    expect(rendered).not.toContain("Secret Title");
    expect(rendered).not.toContain("https://example.com/secret");
    expect(rendered).not.toContain("Secret excerpt");
  });

  it("renderResult collapsed says 'No results' for an empty result set", () => {
    const tool = getRegisteredTool("web_search");
    const component = tool.renderResult?.(
      {
        content: [{ type: "text", text: "No search results found." }],
        details: { resultCount: 0, omitted: 0, truncated: false },
      },
      { expanded: false, isPartial: false },
      theme,
      { isError: false },
    );
    expect(renderText(component as RenderedText)).toBe("No results");
  });

  it("renderResult collapsed reports omitted count and truncated marker", () => {
    const tool = getRegisteredTool("web_search");
    const component = tool.renderResult?.(
      { content: [{ type: "text", text: "body" }], details: { resultCount: 3, omitted: 2, truncated: true } },
      { expanded: false, isPartial: false },
      theme,
      { isError: false },
    );
    const rendered = renderText(component as RenderedText, 60);
    const lines = rendered.split("\n");
    expect(lines.length).toBe(1);
    expect(visibleWidth(lines[0])).toBeLessThanOrEqual(60);
    expect(rendered).toContain("3 results");
    expect(rendered).toContain("2 omitted");
    expect(rendered).toContain("(truncated)");
  });
});
