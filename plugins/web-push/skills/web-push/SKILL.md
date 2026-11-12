---
name: web-push
description: "Send or diagnose real Web Push notifications from bb to browsers and phones, including when bb is closed."
---

# Web Push

The Web Push plugin delivers thread notifications to subscribed browsers through
a service worker, so they arrive even when the bb tab is shut. It complements the
bundled Push notifications plugin: that one only shows foreground browser
notifications (and cannot work at all on Android), and sends Expo pushes to the
native app.

```sh
bb web-push status [--json]                 # enabled, subscribed browsers, last send
bb web-push list [--json]                   # subscriptions, last delivery, last error
bb web-push test [--json]                    # send a test notification
bb web-push send --title <text> [--body <text>] [--thread <thread-id>] [--json]
bb web-push remove <id> [--json]             # forget a browser
bb web-push prune [--json]                   # drop browsers inactive past inactiveDays
bb web-push key [--json]                     # VAPID public key
```

- Check `list` before assuming a delivery problem: `last delivered` is stamped by
  the service worker when it actually shows the notification, and `last error`
  carries the push service's rejection.
- `send` with `--thread` makes a click open that thread; without it a click opens bb.
- Subscribing is a user action: a browser asks for permission on the first click
  or tap in bb, or the person presses **Enable notifications here** in
  Settings → Plugins → Web Push, because browsers require a gesture for the
  permission prompt. You cannot subscribe a browser for them.
- A device with bb open and focused on a thread skips that thread's notification
  (`skipWhenViewing`); other threads and `test`/`send` without `--thread` always
  show.
- Browsers inactive for `inactiveDays` (default 7) are removed automatically and
  re-subscribe themselves the next time they open bb.
- Nothing is delivered when no browser is subscribed; `test` then exits non-zero.

Settings (see `bb plugin config web-push`): the master switch, one toggle per
event kind, `useThreadLevels` to respect the bundled plugin's per-thread levels,
`skipWhenViewing`, `inactiveDays`, `vapidSubject` (a mailto:/https: contact the
push services require), and `urgency`.
