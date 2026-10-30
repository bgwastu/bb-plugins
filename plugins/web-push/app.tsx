// bb-plugin-web-push — frontend entry.
//
// Two surfaces:
//   - a content script that silently keeps this browser's push subscription in
//     sync on every load (no prompts, no UI),
//   - a settings section that owns the permission gesture, the test send, and
//     the list of subscribed browsers.
//
// The settings section is the only place a permission prompt can come from:
// Android and iOS both require a user gesture for `Notification.requestPermission()`.
import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import {
  describeThisBrowser,
  disableHere,
  enableHere,
  existingSubscription,
  notificationPermission,
  syncSubscription,
  supportState,
} from "./web-push-client";

type SubscriptionRow = {
  id: string;
  label: string;
  endpointHost: string;
  createdAt: number;
  lastSeenAt: number;
  lastDeliveredAt: number | null;
  lastError: string | null;
};

function formatWhen(value: number | null): string {
  if (value === null) return "never";
  const delta = Date.now() - value;
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} min ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} h ago`;
  return new Date(value).toLocaleDateString();
}

function WebPushSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const [rows, setRows] = useState<SubscriptionRow[]>([]);
  const [here, setHere] = useState(false);
  const [permission, setPermission] = useState(notificationPermission());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const support = supportState();

  const refresh = useCallback(() => {
    rpc.call("web_push_subscriptions").then(
      (result) => setRows(result.subscriptions),
      (error: unknown) =>
        setMessage(error instanceof Error ? error.message : String(error)),
    );
    void existingSubscription().then((subscription) => setHere(subscription !== null));
    setPermission(notificationPermission());
  }, [rpc]);

  useEffect(() => {
    refresh();
  }, [refresh]);
  useRealtime("web-push-changed", refresh);

  const enable = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      const outcome = await enableHere();
      setMessage(outcome.ok ? `Enabled for ${outcome.label}.` : outcome.error);
      refresh();
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const disable = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      await disableHere();
      setMessage("Turned off for this browser.");
      refresh();
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const sendTest = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await rpc.call("web_push_test");
      setMessage(
        result.sent === 0
          ? `Nothing was delivered (${result.failed} failed, ${result.pruned} dropped).`
          : `Test sent to ${result.sent} browser${result.sent === 1 ? "" : "s"}.`,
      );
      refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [rpc, refresh]);

  const remove = useCallback(
    async (id: string) => {
      setBusy(true);
      try {
        await rpc.call("web_push_remove", { id });
        refresh();
      } finally {
        setBusy(false);
      }
    },
    [rpc, refresh],
  );

  const status =
    support === "insecure"
      ? "Web push needs HTTPS. Open bb over https or localhost."
      : support === "unsupported"
        ? "This browser cannot receive web push (no service worker or push support). On iOS, add bb to the Home Screen first."
        : here
          ? `This browser (${describeThisBrowser()}) is subscribed. Notifications arrive even when bb is closed.`
          : permission === "granted"
            ? "This browser has permission but no subscription yet."
            : permission === "denied"
              ? "Notifications are blocked for this site. Allow them in the browser's site settings, then reload."
              : `Subscribe ${describeThisBrowser()} to notifications that arrive even when bb is closed.`;

  return (
    <div className="space-y-3 text-sm">
      <h3 className="font-medium">Web push</h3>
      <p className="text-muted-foreground" role="status">
        {status}
      </p>

      <div className="flex flex-wrap items-center gap-2">
        {support === "supported" && !here ? (
          <button
            type="button"
            className="rounded-md border border-border px-3 py-2 disabled:opacity-50"
            disabled={busy}
            onClick={enable}
          >
            {permission === "granted" ? "Subscribe this browser" : "Enable notifications here"}
          </button>
        ) : null}
        {support === "supported" && here ? (
          <button
            type="button"
            className="rounded-md border border-border px-3 py-2 disabled:opacity-50"
            disabled={busy}
            onClick={disable}
          >
            Turn off in this browser
          </button>
        ) : null}
        <button
          type="button"
          className="rounded-md border border-border px-3 py-2 disabled:opacity-50"
          disabled={busy || rows.length === 0}
          onClick={sendTest}
        >
          Send test notification
        </button>
      </div>

      {message === null ? null : (
        <p className="text-muted-foreground" role="status">
          {message}
        </p>
      )}

      {rows.length === 0 ? (
        <p className="text-muted-foreground">No browser subscribed yet.</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {rows.map((row) => (
            <li key={row.id} className="flex items-center gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate">{row.label}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {row.endpointHost} · delivered {formatWhen(row.lastDeliveredAt)}
                  {row.lastError === null ? "" : ` · last error: ${row.lastError}`}
                </p>
              </div>
              <button
                type="button"
                className="rounded-md border border-border px-2 py-1 text-xs disabled:opacity-50"
                disabled={busy}
                onClick={() => remove(row.id)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="text-xs text-muted-foreground">
        Threads follow their own notification level, and the bundled Notifications plugin's quiet
        threads stay quiet here too. Keep the phone out of battery restrictions so push can wake
        the browser.
      </p>
    </div>
  );
}

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "web-push-client",
    mount({ signal }) {
      let active = true;
      const sync = () => {
        if (!active) return;
        void syncSubscription().catch(() => {
          // A missing plugin route, a revoked permission, or a browser without
          // push support all land here; the settings section explains them.
        });
      };
      sync();
      const onVisible = () => {
        if (document.visibilityState === "visible") sync();
      };
      document.addEventListener("visibilitychange", onVisible);
      return () => {
        active = false;
        document.removeEventListener("visibilitychange", onVisible);
        void signal;
      };
    },
  });

  app.slots.settingsSection({
    id: "web-push-devices",
    component: WebPushSettings,
  });
});
