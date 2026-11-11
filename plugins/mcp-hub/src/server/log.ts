import type { BbPluginApi } from "@get-bb/plugin-sdk";

/**
 * Logging that can never crash the host.
 *
 * Background work - a scheduled catalog refresh, a project list that has not
 * come back yet - can outlive the plugin load that started it, and every `bb`
 * member throws `PluginContextStaleError` once the handle is stale. A log line
 * is never worth taking the BB server process down with it.
 */
export function warnQuietly(bb: BbPluginApi, message: string): void {
  try {
    bb.log.warn(message);
  } catch {
    // The plugin was disposed while this work was in flight.
  }
}

export function infoQuietly(bb: BbPluginApi, message: string): void {
  try {
    bb.log.info(message);
  } catch {
    // The plugin was disposed while this work was in flight.
  }
}

/** The `{ warn, info }` logger the MCP stack's modules take, made safe to
 * call from work that outlives the load. */
export function quietLogger(bb: BbPluginApi): {
  warn(message: string): void;
  info(message: string): void;
} {
  return {
    warn: (message) => warnQuietly(bb, message),
    info: (message) => infoQuietly(bb, message),
  };
}
