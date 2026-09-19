import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createIdentityTheme,
  getRegisteredTool,
  jsonResponse,
  noop,
  ORIGINAL_ENV,
  type RenderedText,
  renderText,
  SECRET_KEY,
} from "./harness";

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
