import { describe, expect, it } from "vitest";
import { MAX_TOOL_NAME, slugify, toolName, uniqueId } from "../src/mcp/naming.js";

describe("slugify", () => {
  it("lowercases and joins words with one dash", () => {
    expect(slugify("My Cool Server!")).toBe("my-cool-server");
  });

  it("never returns an empty id", () => {
    expect(slugify("!!!")).toBe("server");
    expect(slugify("")).toBe("server");
  });

  it("caps the length without leaving a trailing dash", () => {
    const slug = slugify("a".repeat(40));
    expect(slug.length).toBeLessThanOrEqual(24);
    expect(slug.endsWith("-")).toBe(false);
  });
});

describe("uniqueId", () => {
  it("returns the base when free", () => {
    expect(uniqueId("linear", new Set())).toBe("linear");
  });

  it("counts up until it finds a free id", () => {
    expect(uniqueId("linear", new Set(["linear", "linear-2"]))).toBe("linear-3");
  });
});

describe("toolName", () => {
  it("always says which server a tool came from", () => {
    expect(toolName("linear", "create-issue", new Set())).toBe("linear_create-issue");
  });

  it("keeps two servers' same-named tools apart", () => {
    const taken = new Set<string>();
    const first = toolName("a", "search", taken);
    taken.add(first);
    const second = toolName("b", "search", taken);
    expect(first).not.toBe(second);
  });

  it("shortens a long name with a hash instead of cutting it blind", () => {
    const long = "x".repeat(60);
    const name = toolName("server", long, new Set());
    expect(name.length).toBeLessThanOrEqual(MAX_TOOL_NAME);
    const other = toolName("server", `${long}y`, new Set());
    expect(other).not.toBe(name);
  });

  it("stays unique even when a shortened name collides", () => {
    const taken = new Set<string>();
    const first = toolName("server", "y".repeat(60), taken);
    taken.add(first);
    const second = toolName("server", `${"y".repeat(59)}z`, taken);
    expect(second).not.toBe(first);
    expect(second.length).toBeLessThanOrEqual(MAX_TOOL_NAME);
  });

  it("replaces characters BB does not accept", () => {
    expect(toolName("my server", "do:thing", new Set())).toBe("my_server_do_thing");
  });
});
