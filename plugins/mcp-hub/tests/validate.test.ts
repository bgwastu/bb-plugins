import { describe, expect, it } from "vitest";
import { checkArguments, normaliseSchema, recursiveLocalRef } from "../src/mcp/validate.js";

const schema = {
  type: "object",
  properties: {
    query: { type: "string" },
    limit: { type: "integer", minimum: 1 },
    tags: { type: "array", items: { type: "string" } },
  },
  required: ["query"],
  additionalProperties: false,
};

describe("checkArguments", () => {
  it("accepts arguments that match", () => {
    const result = checkArguments(schema, { query: "hello", tags: ["a"] });
    expect(result.ok).toBe(true);
  });

  it("names the missing field", () => {
    const result = checkArguments(schema, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("arguments.query is required");
  });

  it("names a field of the wrong type", () => {
    const result = checkArguments(schema, { query: 12 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("arguments.query");
  });

  it("refuses an argument the tool does not accept", () => {
    const result = checkArguments(schema, { query: "ok", nope: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("arguments.nope");
  });

  it("treats no arguments as an empty object", () => {
    const loose = { type: "object", properties: {} };
    expect(checkArguments(loose, undefined)).toEqual({ ok: true, arguments: {} });
    expect(checkArguments(loose, null)).toEqual({ ok: true, arguments: {} });
  });

  it("refuses a non-object, which used to become {}", () => {
    expect(checkArguments(schema, "hello").ok).toBe(false);
    expect(checkArguments(schema, [1, 2]).ok).toBe(false);
  });

  it("does not enforce a schema ajv cannot compile", () => {
    const broken = { type: "object", properties: { a: { type: "not-a-type" } } };
    expect(checkArguments(broken, { a: 1 }).ok).toBe(true);
  });

  it("reports several problems at once, bounded", () => {
    const result = checkArguments(
      { type: "object", properties: { a: { type: "string" }, b: { type: "string" } }, required: ["a", "b"] },
      {},
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message.split(";").length).toBeGreaterThan(1);
  });
});

describe("recursiveLocalRef", () => {
  it("finds a cycle through a local pointer", () => {
    const cyclic = {
      type: "object",
      properties: { node: { $ref: "#/definitions/node" } },
      definitions: { node: { type: "object", properties: { child: { $ref: "#/definitions/node" } } } },
    };
    expect(recursiveLocalRef(cyclic)).toBe("#/definitions/node");
  });

  it("leaves a one-way reference alone", () => {
    const acyclic = {
      type: "object",
      properties: { node: { $ref: "#/definitions/node" } },
      definitions: { node: { type: "object", properties: { value: { type: "string" } } } },
    };
    expect(recursiveLocalRef(acyclic)).toBeNull();
  });

  it("ignores a remote reference", () => {
    expect(recursiveLocalRef({ type: "object", properties: { a: { $ref: "https://x/y.json" } } })).toBeNull();
  });
});

describe("normaliseSchema", () => {
  it("adds a root object type where the server left it out", () => {
    expect(normaliseSchema({ properties: { a: { type: "string" } } })).toEqual({
      type: "object",
      properties: { a: { type: "string" } },
    });
  });

  it("keeps a schema that already says object", () => {
    const original = { type: "object", properties: {} };
    expect(normaliseSchema(original)).toBe(original);
  });
});
