import { describe, expect, it } from "vitest";
import { parseReadPage, SEARCH_TITLE_MAX_CHARS, SEARCH_URL_MAX_CHARS } from "../src/web-content";

describe("parseReadPage", () => {
  const page = { url: "https://example.com/page", text: "Page text" };

  it("trims URL/text and normalizes and caps the optional title", () => {
    const title = `Title\n\t${"x".repeat(SEARCH_TITLE_MAX_CHARS)}`;
    expect(parseReadPage({ url: ` ${page.url}\n`, text: " \nPage\ntext\t ", title })).toEqual({
      url: page.url,
      text: "Page\ntext",
      title: `Title ${"x".repeat(SEARCH_TITLE_MAX_CHARS - 7)}…`,
    });
  });

  it.each([undefined, "", " \n\t "])("omits an empty or missing title: %j", (title) => {
    expect(parseReadPage({ ...page, title })).toEqual({ ...page, title: undefined });
  });

  it("accepts the exact URL bound after trimming, but rejects an oversized URL", () => {
    const url = `http://example.com/${"x".repeat(SEARCH_URL_MAX_CHARS - "http://example.com/".length)}`;
    expect(parseReadPage({ ...page, url: ` ${url} ` })?.url).toBe(url);
    expect(parseReadPage({ ...page, url: `${url}x` })).toBeUndefined();
  });

  it.each([
    null,
    [],
    "page",
    {},
    { ...page, text: " \n " },
    { ...page, text: 7 },
    { ...page, url: " " },
    { ...page, url: 7 },
    { ...page, url: "/relative" },
    { ...page, url: "ftp://example.com/page" },
    { ...page, title: null },
    { ...page, title: 7 },
  ])("rejects invalid page data: %j", (value) => {
    expect(parseReadPage(value)).toBeUndefined();
  });
});
