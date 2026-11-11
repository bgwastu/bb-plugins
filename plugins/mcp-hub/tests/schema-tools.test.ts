import { describe, expect, it } from "vitest";
import { flattenSchema, RecursiveSchemaError } from "../src/mcp/schema-tools.js";

describe("flattenSchema", () => {
  it("inlines a non-recursive local $ref", () => {
    const flat = flattenSchema({
      type: "object",
      properties: { a: { $ref: "#/$defs/leaf" } },
      $defs: { leaf: { type: "string" } },
    });
    expect(flat).toEqual({
      type: "object", properties: { a: { type: "string" } },
    });
  });

  it("throws on a cyclic $ref", () => {
    expect(() => flattenSchema({
      type: "object",
      properties: { self: { $ref: "#/$defs/node" } },
      $defs: { node: { type: "object", properties: { next: { $ref: "#/$defs/node" } } } },
    })).toThrow(RecursiveSchemaError);
  });

  it("coerces a non-object root to an empty object schema", () => {
    expect(flattenSchema(null)).toEqual({ type: "object" });
    expect(flattenSchema({ type: "string" })).toEqual({ type: "object" });
  });

  it("resolves a $ref through a $defs key containing a raw percent sign without throwing", () => {
    expect(() => flattenSchema({
      type: "object",
      properties: { a: { $ref: "#/$defs/50%off" } },
      $defs: { "50%off": { type: "string" } },
    })).not.toThrow();
    const flat = flattenSchema({
      type: "object",
      properties: { a: { $ref: "#/$defs/50%off" } },
      $defs: { "50%off": { type: "string" } },
    });
    expect(flat).toEqual({
      type: "object", properties: { a: { type: "string" } },
    });
  });
});
