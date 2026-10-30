# Web Push

Notifications for bb that actually arrive on a phone, or in a browser you
closed an hour ago.

bb's bundled **Push notifications** plugin shows web notifications with
`new Notification(...)`. Chromium refuses that constructor on Android
("Illegal constructor. Use `ServiceWorkerRegistration.showNotification()`
instead"), and on every platform it needs an open, focused tab. This plugin does
the real thing: a service worker plus VAPID Web Push, so a thread finishing on
your machine wakes the phone.

## Setup

1. Install the plugin and open **Settings → Plugins → Web Push**.
2. Press **Enable notifications here** (the browser only allows the prompt from
   a click).
3. That browser is now subscribed. Repeat on any other browser or phone.

On iOS, add bb to the Home Screen first — Safari only delivers push to installed
web apps.

Nothing else is required: the VAPID key pair is generated on first load and kept
in the plugin's storage.

## What triggers a notification

`turn.finished`, `thread.failed`, and `interaction.pending` (questions,
approvals, plan reviews). A burst of events for one thread collapses into a
single push about 1.5 s later.

Each thread's own notification level is respected, read from the bundled
Notifications plugin, including the ancestor cap and the child-thread default —
so muted threads stay quiet. Turn off **Respect thread notification levels** to
notify for everything.

A thread you already read after the event is skipped, so having bb open on your
desktop does not buzz your phone.

## CLI

```sh
bb web-push status [--json]          # enabled, subscriptions, last send
bb web-push list [--json]            # subscribed browsers, last delivery
bb web-push key [--json]             # VAPID public key
bb web-push remove <id> [--json]
bb web-push test [--json]            # send a test notification
bb web-push send --title <text> [--body <text>] [--thread <id>] [--json]
```

## How it is built

- `push-crypto.ts` — RFC 8291 (`aes128gcm`) payload encryption and RFC 8292
  VAPID `ES256` tokens on `node:crypto`, no dependencies.
- `service-worker.ts` — the worker served at
  `/api/v1/plugins/web-push/http/sw.js`, which renders the notification, reports
  delivery back, opens the thread on click, and re-subscribes when the browser
  rotates a subscription.
- `server.ts` — subscription store, thread-event hooks, and the plugin's RPC,
  HTTP, and CLI surfaces.
- `web-push-client.ts` — browser side: registers the worker, subscribes, and
  keeps the server's copy current.
- `app.tsx` — the settings section and the content script that syncs silently.

## Tests

Both run against a live bb (`BB_URL`, default `http://127.0.0.1:38886`):

```sh
node scripts/test-crypto.ts    # RFC 8291 §5 vector + VAPID verification
node scripts/test-delivery.ts  # encrypted push to a mock push service, ack, pruning
```

`test-delivery.ts` starts a mock push service that plays the browser: it holds a
real P-256 key pair, verifies the VAPID header, decrypts the body with the same
derivation a browser uses, posts the delivery ack, then answers `410` to prove
dead subscriptions are pruned.

## Notes

- Web push reaches the browser even with bb closed, but the phone must be allowed
  to wake the browser: exempt Chrome from aggressive battery restrictions on
  Xiaomi/HyperOS, Samsung, and similar devices.
- If you also subscribe a desktop browser, bb's built-in foreground notifications
  can duplicate a push while that tab is open. Remove the browser here if you
  would rather keep only one.
- The bundled plugin's **Desktop** channel is unaffected; **Mobile** (Expo push)
  stays available for the native bb app.
