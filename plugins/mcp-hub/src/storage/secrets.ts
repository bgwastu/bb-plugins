// Credentials live in one 0600 JSON file next to the plugin database, never in
// the database itself and never in an RPC response. The file is small (a few
// servers), so it is read once and rewritten atomically on every change.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface OAuthSecrets {
  /** `OAuthTokens` as the MCP SDK stores them. */
  tokens?: Record<string, unknown>;
  /** Dynamically registered client, as the MCP SDK stores it. */
  client?: Record<string, unknown>;
  /** The redirect URI the registered client and the pending flow were made for. */
  redirectUri?: string;
  codeVerifier?: string;
  state?: string;
  /** Cached authorization-server discovery, as the MCP SDK stores it. */
  discovery?: Record<string, unknown>;
}

export interface ServerSecrets {
  env?: Record<string, string>;
  headers?: Record<string, string>;
  bearer?: string;
  oauthClientSecret?: string;
  oauth?: OAuthSecrets;
}

export interface SecretStore {
  get(serverId: string): ServerSecrets;
  update(serverId: string, change: (current: ServerSecrets) => ServerSecrets): void;
  remove(serverId: string): void;
  /** Finds the server whose pending OAuth flow carries this `state`. */
  findByOAuthState(state: string): string | null;
}

export function createSecretStore(filePath: string | null): SecretStore {
  let data: Record<string, ServerSecrets> = {};
  if (filePath !== null && existsSync(filePath)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
      if (parsed !== null && typeof parsed === "object") {
        data = parsed as Record<string, ServerSecrets>;
      }
    } catch {
      // A corrupt file must not stop the plugin loading; the affected servers
      // show up as needing sign-in, which is the truth.
      data = {};
    }
  }

  function persist(): void {
    if (filePath === null) return;
    mkdirSync(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.tmp`;
    writeFileSync(temporary, JSON.stringify(data), { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, filePath);
  }

  return {
    get: (serverId) => structuredClone(data[serverId] ?? {}),
    update(serverId, change) {
      data[serverId] = change(structuredClone(data[serverId] ?? {}));
      persist();
    },
    remove(serverId) {
      if (!(serverId in data)) return;
      delete data[serverId];
      persist();
    },
    findByOAuthState(state) {
      for (const [serverId, secrets] of Object.entries(data)) {
        if (secrets.oauth?.state === state) return serverId;
      }
      return null;
    },
  };
}

/** The secrets file for a database handle, or `null` for an in-memory one. */
export function secretsPathFor(databaseName: string): string | null {
  if (databaseName === "" || databaseName === ":memory:") return null;
  return path.join(path.dirname(databaseName), "secrets", "servers.json");
}
