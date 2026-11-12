// The service worker served at /api/v1/plugins/web-push/http/sw.js.
//
// It is a plain string because the browser fetches it as a script: no bundler
// touches it, and the server injects the live VAPID public key and route URLs
// on every request. Anything that needs a value from the plugin's settings
// arrives through `push` payloads instead.
//
// Doing notifications here rather than with `new Notification()` is the whole
// point of the plugin: Chromium refuses the constructor on Android ("Illegal
// constructor. Use ServiceWorkerRegistration.showNotification() instead"), so
// a notification shown by a service worker is the only form that works on a
// phone, and a push subscription is what reaches a browser whose tab is closed.

export type ServiceWorkerConfig = {
  /** Raw uncompressed P-256 public key, base64url — reused on resubscribe. */
  publicKey: string;
  /** Mounted route paths for the SW's own reports. */
  deliveryPath: string;
  resubscribePath: string;
  /** Name prefix of the Web Lock a focused bb tab holds per thread. */
  focusLockPrefix: string;
};

export function renderServiceWorker(config: ServiceWorkerConfig): string {
  return `"use strict";
const APPLICATION_SERVER_KEY = "${config.publicKey}";
const DELIVERY_PATH = ${JSON.stringify(config.deliveryPath)};
const RESUBSCRIBE_PATH = ${JSON.stringify(config.resubscribePath)};
const FOCUS_LOCK_PREFIX = ${JSON.stringify(config.focusLockPrefix)};
// Safari (iOS, iPadOS posing as a Mac, and macOS) requires a visible
// notification for every push and revokes the subscription after a few silent
// ones, so it never skips. Chrome on macOS also says "Safari/", hence the
// exclusions.
function isSafari(userAgent) {
  if (/iPhone|iPad|iPod/u.test(userAgent)) return true;
  return /Safari[/]/u.test(userAgent) && !/(Chrome|Chromium|Edg|OPR|Firefox)[/]/u.test(userAgent);
}

function decodeApplicationServerKey(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

// True only when this device is looking at the thread right now: a window of
// this origin has focus (web.dev: the one case where a push may go without a
// notification) and that window holds the thread's focus lock. Any doubt means
// false, because a duplicate notification is better than a missed one.
async function isViewingThread(threadId) {
  if (threadId === null) return false;
  try {
    if (isSafari(self.navigator.userAgent || "")) return false;
    const locks = self.navigator.locks;
    if (!locks || typeof locks.query !== "function") return false;
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (!windows.some((client) => client.focused === true)) return false;
    const snapshot = await locks.query();
    const wanted = FOCUS_LOCK_PREFIX + threadId;
    return (snapshot.held || []).some((lock) => lock.name === wanted);
  } catch {
    return false;
  }
}

// Also sent for a push that was skipped: it proves the device is alive, which
// is what keeps the subscription from being pruned as inactive.
async function reportDelivery() {
  try {
    const subscription = await self.registration.pushManager.getSubscription();
    await fetch(DELIVERY_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ endpoint: subscription ? subscription.endpoint : null, shownAt: Date.now() }),
    });
  } catch {
    // Reporting is best effort: a failed ack must never lose the notification.
  }
}

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data ? event.data.text() : "" };
  }
  const title = typeof payload.title === "string" && payload.title.trim() !== "" ? payload.title : "bb";
  const options = {
    body: typeof payload.body === "string" ? payload.body : "",
    tag: typeof payload.tag === "string" && payload.tag !== "" ? payload.tag : "bb",
    renotify: true,
    data: {
      url: typeof payload.url === "string" && payload.url.startsWith("/") ? payload.url : "/",
      threadId: typeof payload.threadId === "string" ? payload.threadId : null,
      kind: typeof payload.kind === "string" ? payload.kind : "message",
    },
    icon: "/icon-192.png",
    badge: "/icon-monochrome-192.png",
    timestamp: Date.now(),
  };
  const threadId = options.data.threadId;
  const skipWhenViewing = payload.skipWhenViewing !== false;
  event.waitUntil(
    (async () => {
      if (skipWhenViewing && (await isViewingThread(threadId))) {
        await reportDelivery();
        return;
      }
      await self.registration.showNotification(title, options);
      await reportDelivery();
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data && event.notification.data.url ? event.notification.data.url : "/", self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        await client.focus();
        if (client.url !== target) {
          try {
            await client.navigate(target);
          } catch {
            // Cross-document navigation can be refused; the focus alone still helps.
          }
        }
        return;
      }
      await self.clients.openWindow(target);
    })(),
  );
});

self.addEventListener("pushsubscriptionchange", (event) => {
  const previous = event.oldSubscription;
  event.waitUntil(
    (async () => {
      const options = {
        userVisibleOnly: true,
        applicationServerKey: decodeApplicationServerKey(APPLICATION_SERVER_KEY),
      };
      const subscription = await self.registration.pushManager.subscribe(options);
      const json = subscription.toJSON();
      await fetch(RESUBSCRIBE_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          endpoint: json.endpoint,
          keys: json.keys,
          previousEndpoint: previous ? previous.endpoint : null,
          userAgent: self.navigator.userAgent,
        }),
      });
    })(),
  );
});
`;
}
