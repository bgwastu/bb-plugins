// The one name the page and the service worker must agree on.
//
// A bb tab that is visible and focused, with a thread open, holds a shared Web
// Lock called `${FOCUS_LOCK_PREFIX}${threadId}`. Locks are shared by every
// page and worker of an origin, so the service worker can ask
// `navigator.locks.query()` whether anyone is looking at a thread right now.
//
// bb's built-in notifications plugin does the same with its own
// `bb-notifications-focus-` names; this plugin keeps a separate prefix because
// that one is only held while an experiment is on and is not a public contract.
export const FOCUS_LOCK_PREFIX = "web-push-focus-";
