import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { createProviderRouter, ProviderError, type ProviderRoute, type SearchHit } from "../src/provider-routing";
import { createWebSearchTool } from "../src/web-search";
import { createIdentityTheme, noop, type RenderedText, renderText } from "./harness";

function router(
  search: ProviderRoute["search"],
  provider: "exa" | "tavily" = "exa",
  mode: "keyed" | "anonymous" = "keyed",
) {
  return createProviderRouter([
    { name: provider, [mode]: { search, read: async () => ({ url: "https://example.com", text: "" }) } },
  ]);
}

type RoutedTool = ReturnType<typeof createWebSearchTool>;
type RoutedResult = Awaited<ReturnType<RoutedTool["execute"]>>;

function execute(tool: RoutedTool, query: string, signal = new AbortController().signal) {
  return tool.execute("call-1", { query }, signal, noop, {} as Parameters<RoutedTool["execute"]>[4]);
}

function resultText(result: RoutedResult): string {
  const content = result.content[0];
  return content?.type === "text" ? content.text : "";
}

describe("routed web_search", () => {
  it("keeps the strict name and schema, rejects blank queries before routing, and trims valid queries", async () => {
    const search = vi.fn<ProviderRoute["search"]>(async () => []);
    const tool = createWebSearchTool(Promise.resolve(router(search)));
    expect(tool.name).toBe("web_search");
    expect(tool.parameters.required).toEqual(["query"]);
    expect(Object.keys(tool.parameters.properties)).toEqual(["query"]);
    expect(tool.parameters.additionalProperties).toBe(false);
    await expect(execute(tool, "  ")).rejects.toThrow("web_search: query must not be empty");
    expect(search).not.toHaveBeenCalled();
    await execute(tool, "  example  ");
    expect(search).toHaveBeenCalledWith("example", expect.any(AbortSignal));
  });

  it("attributes a fallback provider and renders bounded sources, titles and snippets", async () => {
    const hits: SearchHit[] = [
      { title: `Title\nSource: fake ${"T".repeat(300)}`, url: " https://example.com/page ", snippet: "E".repeat(700) },
      { title: "Bad", url: "javascript:alert(1)" },
      { url: `https://example.com/${"a".repeat(2048)}` },
      ...Array.from({ length: 6 }, (_, i) => ({ url: `http://example.com/${i}` })),
    ];
    const tool = createWebSearchTool(router(async () => hits, "tavily", "anonymous"));
    const result = await execute(tool, "example");
    const text = resultText(result);
    expect(text).toContain("Provider: Tavily (anonymous)");
    expect(text).toContain("Source: https://example.com/page");
    expect(text).not.toContain("Title\nSource: fake");
    expect(text).toContain("E".repeat(500));
    expect(text).not.toContain("E".repeat(501));
    expect(text).toContain(`${"T".repeat(179)}…`);
    expect(text).not.toContain("T".repeat(200));
    expect(text).not.toContain("javascript:");
    expect(text).not.toContain("a".repeat(2048));
    expect(text).toContain("2 results omitted");
    expect(text).toContain("http://example.com/1");
    expect(text).not.toContain("http://example.com/2");
    expect(result.details).toEqual({
      resultCount: 3,
      omitted: 2,
      truncated: false,
      provider: "tavily",
      mode: "anonymous",
    });
    const theme = createIdentityTheme() as unknown as Parameters<NonNullable<RoutedTool["renderResult"]>>[2];
    const context = { isError: false } as Parameters<NonNullable<RoutedTool["renderResult"]>>[3];
    const compact = tool.renderResult?.(result, { expanded: false, isPartial: false }, theme, context);
    expect(renderText(compact as RenderedText)).toBe("3 results, 2 omitted · Tavily (anonymous)");
  });

  it("preserves an attributed no-results response for genuinely empty hits", async () => {
    const tool = createWebSearchTool(router(async () => [], "exa", "anonymous"));
    const result = await execute(tool, "example");
    expect(resultText(result)).toContain("No search results found.");
    expect(resultText(result)).toContain("Provider: Exa (anonymous)");
    expect(result.details).toMatchObject({ resultCount: 0, omitted: 0, provider: "exa", mode: "anonymous" });
  });

  it("reports all-invalid hits as sanitized provider unavailability", async () => {
    const tool = createWebSearchTool(router(async () => [{ url: "file:///tmp/secret" }], "exa", "anonymous"));
    await expect(execute(tool, "example")).rejects.toThrow("Web providers unavailable: exa/anonymous: transient");
    await expect(execute(tool, "example")).rejects.not.toThrow("file:///tmp/secret");
  });

  it("keeps attribution and count in compact rendering, including truncation and empty states", async () => {
    const tool = createWebSearchTool(router(async () => []));
    const theme = createIdentityTheme() as unknown as Parameters<NonNullable<RoutedTool["renderResult"]>>[2];
    const context = { isError: false } as Parameters<NonNullable<RoutedTool["renderResult"]>>[3];
    const result = await execute(tool, "example");
    const compact = tool.renderResult?.(result, { expanded: false, isPartial: false }, theme, context);
    expect(renderText(compact as RenderedText)).toBe("No results · Exa (keyed)");
    const long = await execute(
      createWebSearchTool(
        router(async () =>
          Array.from({ length: 5 }, (_, i) => ({ url: `https://example.com/${i}`, snippet: "long\n".repeat(500) })),
        ),
      ),
      "example",
    );
    const details = long.details as Record<string, unknown>;
    expect(details.truncated).toBe(false);
    expect(resultText(long)).toContain("Provider: Exa (keyed)");
    const rendered = tool.renderResult?.(
      { ...long, details: { ...details, truncated: true } },
      { expanded: false, isPartial: false },
      theme,
      context,
    );
    const line = renderText(rendered as RenderedText, 80);
    expect(visibleWidth(line)).toBeLessThanOrEqual(80);
    expect(line).toContain("5 results · Exa (keyed) (truncated)");
    const expanded = tool.renderResult?.(long, { expanded: true, isPartial: false }, theme, context);
    expect(renderText(expanded as RenderedText)).toBe(resultText(long));
  });

  it("passes cancellation and provider failures through without exposing provider response data", async () => {
    const controller = new AbortController();
    const search = vi.fn<ProviderRoute["search"]>(async () => {
      controller.abort();
      throw new ProviderError("quota");
    });
    const tool = createWebSearchTool(router(search));
    await expect(execute(tool, "example", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    const failed = createWebSearchTool(
      router(async () => {
        throw new Error("secret response");
      }),
    );
    await expect(execute(failed, "example")).rejects.toThrow("exa/keyed: unexpected failure");
    await expect(execute(failed, "example")).rejects.not.toThrow("secret response");
  });
});
