// One place that talks to the backend, so no component invents its own poll.
import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRealtimeConnectionState } from "@get-bb/plugin-sdk/app";
import { MCP_CHANGED, type Snapshot } from "../../contract.js";
import { useApi } from "./rpc.js";

/** The browser origin, which is where the OAuth redirect must land. */
export function currentOrigin(): string | undefined {
  if (typeof window === "undefined") return undefined;
  return window.location.origin.startsWith("http") ? window.location.origin : undefined;
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error);
}

/**
 * The plugin's state, refreshed by its own change signal.
 *
 * The signal is ephemeral and never replayed, so a reconnect has to refetch:
 * anything published while the socket was down was published to nobody.
 */
export function useSnapshot(): {
  snapshot: Snapshot | null;
  error: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
} {
  const rpc = useApi();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      setSnapshot(await rpc.snapshot({ origin: currentOrigin() }));
      setError(null);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [rpc]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useRealtime(MCP_CHANGED, () => {
    void refresh();
  });

  const connection = useRealtimeConnectionState();
  const previous = useRef(connection);
  useEffect(() => {
    if (previous.current !== "connected" && connection === "connected") void refresh();
    previous.current = connection;
  }, [connection, refresh]);

  // A server that is connecting finishes without publishing until it is done,
  // so this keeps the dots honest while the signal is quiet.
  useEffect(() => {
    const busy = snapshot?.servers.some((server) => server.state === "connecting") ?? false;
    if (!busy) return;
    const timer = setInterval(() => void refresh(), 1500);
    return () => clearInterval(timer);
  }, [snapshot, refresh]);

  return { snapshot, error, loading, refresh };
}
