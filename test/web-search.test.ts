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

const originalTavilyKey = process.env.TAVILY_API_KEY;

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
    if (originalTavilyKey === undefined) {
      delete process.env.TAVILY_API_KEY;
    } else {
      process.env.TAVILY_API_KEY = originalTavilyKey;
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

  it("routes Exa keyed quota to anonymous MCP, then MCP rate limit to Tavily on the same activation", async () => {
    process.env.TAVILY_API_KEY = "secret-tavily-key";
    vi.spyOn(Math, "random").mockReturnValue(0);
    const calls: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      calls.push(url);
      if (url === "https://api.exa.ai/search") {
        expect(new Headers(init?.headers).get("x-api-key")).toBe(SECRET_KEY);
        return jsonResponse({ error: `quota: ${SECRET_KEY}` }, 402);
      }
      if (url === "https://mcp.exa.ai/mcp") {
        expect(JSON.parse(init?.body as string)).toMatchObject({
          method: "tools/call",
          params: { name: "web_search_exa", arguments: { query: "example", numResults: 5 } },
        });
        return calls.filter((call) => call === url).length === 1
          ? jsonResponse({
              jsonrpc: "2.0",
              id: 1,
              result: {
                content: [{ type: "text", text: "Title: MCP hit\nURL: https://example.com/mcp\nText: MCP excerpt" }],
              },
            })
          : jsonResponse({ error: `rate limited: ${SECRET_KEY}` }, 429);
      }
      if (url === "https://api.tavily.com/search") {
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer secret-tavily-key");
        return jsonResponse({
          results: [{ title: "Tavily hit", url: "https://example.com/tavily", content: "Tavily excerpt" }],
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const tool = getRegisteredTool("web_search");

    const first = await tool.execute("call-1", { query: "example" }, new AbortController().signal, noop, {});
    expect(first.content[0].text).toContain("Provider: Exa (anonymous)");
    expect(first.content[0].text).toContain("1. MCP hit\nSource: https://example.com/mcp\nMCP excerpt");
    expect(first.details).toEqual({ resultCount: 1, omitted: 0, truncated: false, provider: "exa", mode: "anonymous" });

    const second = await tool.execute("call-2", { query: "example" }, new AbortController().signal, noop, {});
    expect(second.content[0].text).toContain("Provider: Tavily (keyed)");
    expect(second.content[0].text).toContain("1. Tavily hit\nSource: https://example.com/tavily\nTavily excerpt");
    expect(second.details).toEqual({ resultCount: 1, omitted: 0, truncated: false, provider: "tavily", mode: "keyed" });
    expect(calls).toEqual([
      "https://api.exa.ai/search",
      "https://mcp.exa.ai/mcp",
      "https://mcp.exa.ai/mcp",
      "https://api.tavily.com/search",
    ]);
    expect(JSON.stringify([first, second])).not.toContain(SECRET_KEY);
    expect(JSON.stringify([first, second])).not.toContain("secret-tavily-key");
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
