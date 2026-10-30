// Browser side of web push: register the service worker, keep one push
// subscription per browser profile in sync with the server.
//
// Shared by the app's content script (silent sync on every load) and the
// settings section (the user gesture that grants permission), because
// `Notification.requestPermission()` must be called from a click on Android and
// iOS — nothing here may prompt on its own.

const HTTP = "/api/v1/plugins/web-push/http";
export const SERVICE_WORKER_PATH = `${HTTP}/sw.js`;
export const SERVICE_WORKER_SCOPE = `${HTTP}/`;

export type DeliveryConfig = {
  enabled: boolean;
  publicKey: string;
  swPath: string;
  scope: string;
};

export type EnableOutcome = { ok: true; label: string } | { ok: false; error: string };

export function supportState(): "supported" | "unsupported" | "insecure" {
  if (typeof window === "undefined") return "unsupported";
  if (!window.isSecureContext) return "insecure";
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return "unsupported";
  if (typeof Notification === "undefined") return "unsupported";
  return "supported";
}

export function notificationPermission(): NotificationPermission | "unsupported" {
  if (supportState() !== "supported") return "unsupported";
  return Notification.permission;
}

export function describeThisBrowser(): string {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const platform = /Android/u.test(ua)
    ? "Android"
    : /iPhone|iPad|iPod/u.test(ua)
      ? "iOS"
      : /Macintosh|Mac OS X/u.test(ua)
        ? "macOS"
        : /Windows/u.test(ua)
          ? "Windows"
          : /Linux/u.test(ua)
            ? "Linux"
            : "this device";
  const browser = /Edg\//u.test(ua)
    ? "Edge"
    : /OPR\//u.test(ua)
      ? "Opera"
      : /Chrome\/|CriOS\//u.test(ua)
        ? "Chrome"
        : /Firefox\/|FxiOS\//u.test(ua)
          ? "Firefox"
          : /Safari\//u.test(ua)
            ? "Safari"
            : "Browser";
  return `${browser} on ${platform}`;
}

function decodeApplicationServerKey(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function readJson<T>(path: string): Promise<T> {
  const response = await fetch(`${HTTP}${path}`, { credentials: "same-origin" });
  if (!response.ok) throw new Error(`${path} answered HTTP ${response.status}`);
  return (await response.json()) as T;
}

async function postJson(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${HTTP}${path}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path} answered HTTP ${response.status}`);
  return await response.json().catch(() => null);
}

export async function readConfig(): Promise<DeliveryConfig> {
  return await readJson<DeliveryConfig>("/config");
}

async function registrationFor(): Promise<ServiceWorkerRegistration> {
  const registration = await navigator.serviceWorker.register(SERVICE_WORKER_PATH, {
    scope: SERVICE_WORKER_SCOPE,
  });
  if (registration.active) return registration;
  const worker = registration.installing ?? registration.waiting;
  if (worker === null || worker === undefined) return registration;
  await new Promise<void>((resolve) => {
    const done = () => resolve();
    worker.addEventListener("statechange", () => {
      if (worker.state === "activated") done();
    });
    window.setTimeout(done, 5_000);
  });
  return registration;
}

export async function existingSubscription(): Promise<PushSubscription | null> {
  if (supportState() !== "supported") return null;
  try {
    const registration = await navigator.serviceWorker.getRegistration(SERVICE_WORKER_SCOPE);
    if (registration === undefined) return null;
    return await registration.pushManager.getSubscription();
  } catch {
    return null;
  }
}

async function publishSubscription(subscription: PushSubscription, label: string): Promise<void> {
  const json = subscription.toJSON();
  if (json.endpoint === undefined || json.keys === undefined) {
    throw new Error("the browser returned an incomplete subscription");
  }
  await postJson("/subscribe", {
    endpoint: json.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
    label,
    userAgent: navigator.userAgent,
  });
}

/**
 * Silent path, safe on every app load: only acts when permission is already
 * granted, and never prompts.
 */
export async function syncSubscription(): Promise<void> {
  if (supportState() !== "supported") return;
  const config = await readConfig();
  if (!config.enabled) {
    await disableHere();
    return;
  }
  if (Notification.permission !== "granted") return;
  const registration = await registrationFor();
  let subscription = await registration.pushManager.getSubscription();
  if (subscription === null) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: decodeApplicationServerKey(config.publicKey),
    });
  }
  await publishSubscription(subscription, describeThisBrowser());
}

/**
 * The gesture path. Requests permission first, so call it straight from a
 * click handler; browsers reject the prompt otherwise.
 */
export async function enableHere(): Promise<EnableOutcome> {
  const support = supportState();
  if (support === "insecure") {
    return { ok: false, error: "Notifications need HTTPS (or localhost)." };
  }
  if (support === "unsupported") {
    return { ok: false, error: "This browser has no service worker push support." };
  }
  const config = await readConfig();
  if (!config.enabled) {
    return { ok: false, error: "Web push is turned off in the plugin settings on the server." };
  }
  let permission = Notification.permission;
  if (permission !== "granted") {
    permission = await Notification.requestPermission();
  }
  if (permission !== "granted") {
    return { ok: false, error: "Notification permission was not granted." };
  }
  const label = describeThisBrowser();
  try {
    const registration = await registrationFor();
    let subscription = await registration.pushManager.getSubscription();
    if (subscription === null) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: decodeApplicationServerKey(config.publicKey),
      });
    }
    await publishSubscription(subscription, label);
    return { ok: true, label };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function disableHere(): Promise<void> {
  const subscription = await existingSubscription();
  if (subscription === null) return;
  try {
    await postJson("/unsubscribe", { endpoint: subscription.endpoint });
  } catch {
    // The local unsubscribe below still matters more than the server row.
  }
  try {
    await subscription.unsubscribe();
  } catch {
    // Nothing else to do: the server row is gone either way.
  }
}
