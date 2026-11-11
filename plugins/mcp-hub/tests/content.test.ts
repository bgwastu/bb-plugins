import { describe, expect, it } from "vitest";
import { toBbContent } from "../src/mcp/content.js";

describe("toBbContent", () => {
  it("passes text and image through", () => {
    expect(toBbContent([
      { type: "text", text: "hi" },
      { type: "image", data: "AAA", mimeType: "image/png" },
    ])).toEqual([
      { type: "text", text: "hi" },
      { type: "image", data: "AAA", mimeType: "image/png" },
    ]);
  });

  it("summarises content types BB rejects", () => {
    const parts = toBbContent([
      { type: "audio", data: "AAA", mimeType: "audio/wav" },
      { type: "resource", resource: { uri: "file:///x.txt", text: "body" } },
    ]);
    expect(parts.every((part) => part.type === "text")).toBe(true);
    expect(JSON.stringify(parts)).toContain("file:///x.txt");
  });

  it("falls back to structuredContent when content is empty", () => {
    expect(toBbContent([], { rows: 2 })).toEqual([
      { type: "text", text: JSON.stringify({ rows: 2 }, null, 2) },
    ]);
  });

  it("truncates oversized text", () => {
    const [part] = toBbContent([{ type: "text", text: "x".repeat(200_000) }]);
    expect(part.type).toBe("text");
    if (part.type === "text") {
      expect(part.text.length).toBeLessThan(200_000);
      expect(part.text).toContain("truncated");
    }
  });

  it("truncates oversized text without splitting a surrogate pair", () => {
    const [part] = toBbContent([
      { type: "text", text: `a${"\u{1F600}".repeat(60_000)}` },
    ]);
    expect(part.type).toBe("text");
    if (part.type === "text") {
      expect(part.text).toContain("truncated");
      expect(
        Array.from(part.text).every((ch) => {
          const code = ch.codePointAt(0)!;
          return code < 0xd800 || code > 0xdfff;
        }),
      ).toBe(true);
    }
  });
});

describe("image cap", () => {
  it("replaces an image over the cap with a note saying what was dropped", () => {
    // 3 MiB of base64 is 2.25 MiB decoded, past the 2 MiB cap.
    const data = "A".repeat(3 * 1024 * 1024);
    const parts = toBbContent([{ type: "image", data, mimeType: "image/png" }]);
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe("text");
    const text = parts[0].type === "text" ? parts[0].text : "";
    expect(text).toContain("image/png");
    expect(text).toContain(String(Buffer.byteLength(data, "base64")));
  });

  it("leaves an image under the cap alone", () => {
    const data = "A".repeat(1024);
    expect(toBbContent([{ type: "image", data, mimeType: "image/png" }]))
      .toEqual([{ type: "image", data, mimeType: "image/png" }]);
  });
});
