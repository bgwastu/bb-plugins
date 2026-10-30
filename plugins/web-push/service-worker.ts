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
};

export function renderServiceWorker(config: ServiceWorkerConfig): string {
  return `"use strict";
const APPLICATION_SERVER_KEY = "${config.publicKey}";
const DELIVERY_PATH = ${JSON.stringify(config.deliveryPath)};
const RESUBSCRIBE_PATH = ${JSON.stringify(config.resubscribePath)};

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

function decodeApplicationServerKey(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

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
  event.waitUntil(
    (async () => {
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
