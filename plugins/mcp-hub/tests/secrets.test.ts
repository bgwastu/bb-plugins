import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSecretStore, secretsPathFor } from "../src/storage/secrets.js";

function tempFile(): { file: string; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "mcp-hub-secrets-"));
  return { file: path.join(dir, "secrets", "servers.json"), dir };
}

describe("secret store", () => {
  it("keeps everything in memory when there is no file", () => {
    const secrets = createSecretStore(null);
    secrets.update("a", () => ({ bearer: "t" }));
    expect(secrets.get("a").bearer).toBe("t");
    secrets.remove("a");
    expect(secrets.get("a")).toEqual({});
    expect(secretsPathFor(":memory:")).toBeNull();
    expect(secretsPathFor("")).toBeNull();
  });

  it("writes a 0600 file and reads it back", () => {
    const { file } = tempFile();
    const first = createSecretStore(file);
    first.update("a", () => ({ bearer: "token", headers: { "X-A": "1" } }));

    expect(statSync(file).mode & 0o777).toBe(0o600);
    const second = createSecretStore(file);
    expect(second.get("a")).toEqual({ bearer: "token", headers: { "X-A": "1" } });
  });

  it("never hands out its own copy", () => {
    const secrets = createSecretStore(null);
    secrets.update("a", () => ({ headers: { "X-A": "1" } }));
    const first = secrets.get("a");
    first.headers!["X-A"] = "tampered";
    expect(secrets.get("a").headers).toEqual({ "X-A": "1" });
  });

  it("survives a corrupt file instead of failing the load", () => {
    const { file, dir } = tempFile();
    mkdirSync(path.join(dir, "secrets"), { recursive: true });
    writeFileSync(file, "{ not json", { mode: 0o600 });
    const secrets = createSecretStore(file);
    expect(secrets.get("a")).toEqual({});
  });

  it("finds a server by the state a flow is carrying", () => {
    const secrets = createSecretStore(null);
    secrets.update("a", () => ({ oauth: { state: "one" } }));
    secrets.update("b", () => ({ oauth: { state: "two" } }));
    expect(secrets.findByOAuthState("two")).toBe("b");
    expect(secrets.findByOAuthState("three")).toBeNull();
  });

  it("writes the whole file atomically, leaving no temporary behind", () => {
    const { file } = tempFile();
    const secrets = createSecretStore(file);
    secrets.update("a", () => ({ bearer: "one" }));
    secrets.update("b", () => ({ bearer: "two" }));
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, { bearer: string }>;
    expect(Object.keys(parsed).sort()).toEqual(["a", "b"]);
  });
});
