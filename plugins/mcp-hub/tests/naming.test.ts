// tests/naming.test.ts
import { describe, expect, it } from "vitest";
import { resolveName } from "../src/mcp/naming.js";

describe("resolveName", () => {
  it("passes an upstream name through untouched", () => {
    expect(resolveName({
      serverId: "notion", upstreamName: "notion-search", taken: new Set(),
    })).toEqual({ registeredName: "notion-search" });
  });

  it("prefixes with the server slug on collision", () => {
    expect(resolveName({
      serverId: "slack", upstreamName: "search", taken: new Set(["search"]),
    })).toEqual({ registeredName: "slack_search", renamedFrom: "search" });
  });

  it("suffixes when even the prefixed name is taken", () => {
    const result = resolveName({
      serverId: "slack", upstreamName: "search",
      taken: new Set(["search", "slack_search"]),
    });
    expect(result.registeredName).toBe("slack_search_2");
  });

  it("sanitises characters outside the allowed set", () => {
    expect(resolveName({
      serverId: "s", upstreamName: "get files/list", taken: new Set(),
    }).registeredName).toBe("get_files_list");
  });

  it("truncates to the provider budget", () => {
    const long = "a".repeat(80);
    const result = resolveName({ serverId: "s", upstreamName: long, taken: new Set() });
    expect(result.registeredName.length).toBeLessThanOrEqual(48);
  });

  it("never returns the reserved bb tool name", () => {
    expect(resolveName({
      serverId: "s", upstreamName: "update_environment_directory", taken: new Set(),
    }).registeredName).not.toBe("update_environment_directory");
  });
});

  it("falls back to prefixed form when upstream name sanitises to empty", () => {
    const result = resolveName({
      serverId: "s", upstreamName: "***", taken: new Set(),
    });
    expect(result.registeredName).not.toBe("");
    expect(result.registeredName.length).toBeGreaterThan(0);
  });

  it("guards against reconstructing the reserved name via prefix", () => {
    const result = resolveName({
      serverId: "update", upstreamName: "environment_directory",
      taken: new Set(["environment_directory"]),
    });
    expect(result.registeredName).not.toBe("update_environment_directory");
  });

  it("truncates result after adding suffix to stay within budget", () => {
    const long = "a".repeat(47);
    const result = resolveName({
      serverId: "s", upstreamName: long,
      taken: new Set([long, `s_${long.substring(0, 46)}`]),
    });
    expect(result.registeredName.length).toBeLessThanOrEqual(48);
  });
