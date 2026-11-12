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

1. Install the plugin and open bb in the browser you want notified.
2. The first click, key press or tap in bb opens the browser's notification
   prompt (browsers only allow it from a gesture). It asks once per browser; if
   you dismiss it, **Settings → Plugins → Web Push → Enable notifications here**
   opens it again.
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

### Quiet while you are looking

A device that has bb open, visible and focused on a thread does not show a
notification for that thread. Every such tab holds a shared Web Lock named
`web-push-focus-<threadId>`; when a push arrives the service worker checks that a
bb window is focused and that the lock for the pushed thread is held. Other
threads, and the same thread on a device you are not using, still notify.
Pushes without a thread (the test button, `bb web-push send` without
`--thread`) always show. Safari always shows, because it requires a visible
notification for every push. Turn it off with **Skip a notification for the
thread you are viewing**. Landing on a thread also closes its notifications that
are already on screen.

### Inactive browsers

A browser that neither opened bb nor acknowledged a push (shown or skipped) for
`inactiveDays` (default 7, `0` disables) is removed by a sweep that runs at start
and every 6 hours. A browser that comes back subscribes again on its next load.
`bb web-push prune` runs the sweep now.

## CLI

```sh
bb web-push status [--json]          # enabled, subscriptions, last send
bb web-push list [--json]            # subscribed browsers, last delivery
bb web-push key [--json]             # VAPID public key
bb web-push remove <id> [--json]
bb web-push prune [--json]           # drop browsers inactive past inactiveDays
bb web-push test [--json]            # send a test notification
bb web-push send --title <text> [--body <text>] [--thread <id>] [--json]
```

## How it is built

- `push-crypto.ts` — RFC 8291 (`aes128gcm`) payload encryption and RFC 8292
  VAPID `ES256` tokens on `node:crypto`, no dependencies.
- `focus-lock.ts` — the lock name shared by the page and the worker.
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

`test-service-worker.ts` needs no server: it runs the generated worker in a
sandbox and checks when a push is shown and when it is skipped. The other two
run against a live bb (`BB_URL`, default `http://127.0.0.1:38886`); note that
`test-delivery.ts` sends a real push to every browser subscribed on that server:

```sh
node scripts/test-service-worker.ts  # show/skip decisions
node scripts/test-crypto.ts          # RFC 8291 §5 vector + VAPID verification
node scripts/test-delivery.ts        # encrypted push to a mock push service, ack, pruning
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
