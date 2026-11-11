import { describe, expect, it } from "vitest";
import { describeParameters } from "../src/server/tool-details.js";

describe("describeParameters", () => {
  it("puts required parameters first and names their types", () => {
    const parameters = describeParameters({
      type: "object",
      properties: {
        limit: { type: "number" },
        query: { type: "string", description: "What to search for" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["query"],
    });
    expect(parameters).toEqual([
      { name: "query", type: "string", required: true, description: "What to search for" },
      { name: "limit", type: "number", required: false, description: null },
      { name: "tags", type: "string[]", required: false, description: null },
    ]);
  });

  it("reads the dialects a provider actually ships", () => {
    const parameters = describeParameters({
      properties: {
        // Nullable, spelled three different ways across real servers.
        a: { type: ["string", "null"] },
        b: { anyOf: [{ type: "string" }, { type: "number" }] },
        c: { enum: ["asc", "desc"] },
        // Too many values to spell out in a row; the raw schema has them.
        d: { enum: [1, 2, 3, 4, 5, 6, 7] },
        e: { type: "string", format: "uri" },
        f: {},
      },
    });
    expect(parameters.map((parameter) => parameter.type)).toEqual([
      "string | null", "string | number", '"asc" | "desc"', "enum", "string (uri)", "any",
    ]);
  });

  it("returns nothing for a schema with no properties", () => {
    expect(describeParameters({ type: "object" })).toEqual([]);
    expect(describeParameters(null)).toEqual([]);
  });
});
