// A logger a background task can call after the load has finished.
//
// A stale `bb` handle throws on any member, and every one of these logs can
// come from work that outlives the load - a listener, a timer, a reconnect
// that fails hours later. A diagnostic line is never worth taking the host
// down with.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export interface HubLogger {
  warn(message: string): void;
  info(message: string): void;
  error(message: string): void;
}

export function quietLogger(bb: BbPluginApi): HubLogger {
  const safe = (level: "warn" | "info" | "error", message: string): void => {
    try {
      bb.log[level](message);
    } catch {
      // The plugin is being disposed; nowhere left to say it.
    }
  };
  return {
    warn: (message) => safe("warn", message),
    info: (message) => safe("info", message),
    error: (message) => safe("error", message),
  };
}

/** Logs a warning without letting a stale handle throw. */
export function warnQuietly(bb: BbPluginApi, message: string): void {
  quietLogger(bb).warn(message);
}
