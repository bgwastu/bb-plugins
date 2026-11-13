import { describe, expect, it } from "vitest";
import { translateResult } from "../src/mcp/content.js";

describe("translateResult", () => {
  it("keeps text as text", () => {
    const translated = translateResult({ content: [{ type: "text", text: "hi" }] });
    expect(translated).toEqual({ content: [{ type: "text", text: "hi" }], isError: false });
  });

  it("keeps structured content even when there is text", () => {
    const translated = translateResult({
      content: [{ type: "text", text: "summary" }],
      structuredContent: { count: 2 },
    });
    expect(translated.content).toHaveLength(2);
    expect(translated.content[1]).toEqual({
      type: "text",
      text: 'Structured result:\n{\n  "count": 2\n}',
    });
  });

  it("passes an image through untouched", () => {
    const translated = translateResult({
      content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
    });
    expect(translated.content[0]).toEqual({ type: "image", data: "AAAA", mimeType: "image/png" });
  });

  it("reads a resource's text body", () => {
    const translated = translateResult({
      content: [
        {
          type: "resource",
          resource: { uri: "file:///a.txt", text: "body" },
        },
      ],
    });
    expect(translated.content[0]).toEqual({ type: "text", text: "file:///a.txt\n\nbody" });
  });

  it("says how much it is not showing of a binary resource", () => {
    const translated = translateResult({
      content: [{ type: "resource", resource: { uri: "file:///a.bin", blob: "AAAA" } }],
    });
    expect(translated.content[0]).toEqual({
      type: "text",
      text: "file:///a.bin (base64, 4 characters)",
    });
  });

  it("turns a link into something readable", () => {
    const translated = translateResult({
      content: [{ type: "resource_link", uri: "https://x", name: "Docs", title: "The docs" }],
    });
    expect(translated.content[0]).toEqual({ type: "text", text: "The docs\nhttps://x" });
  });

  it("carries the error flag through", () => {
    const translated = translateResult({
      content: [{ type: "text", text: "nope" }],
      isError: true,
    });
    expect(translated.isError).toBe(true);
  });

  it("never returns an empty result", () => {
    expect(translateResult({ content: [] }).content).toHaveLength(1);
    expect(translateResult({ content: [], isError: true }).content[0]).toEqual({
      type: "text",
      text: "The tool failed with no message.",
    });
  });
});
