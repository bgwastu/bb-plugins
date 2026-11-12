// Runs the generated service worker in a sandbox with mocked browser APIs and
// checks when a push shows a notification and when it is skipped. It touches
// no bb server and sends nothing.
//
//   node scripts/test-service-worker.ts
import assert from "node:assert/strict";
import vm from "node:vm";
import { renderServiceWorker } from "../service-worker.ts";

const PREFIX = "web-push-focus-";
const CHROME_ANDROID =
  "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const SAFARI_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const SAFARI_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

type Scenario = {
  userAgent?: string;
  windows?: Array<{ focused: boolean }>;
  held?: string[];
  locks?: "missing" | "throws";
  payload?: Record<string, unknown>;
};

async function runPush(scenario: Scenario): Promise<{ shown: number; acks: number }> {
  const listeners = new Map<string, (event: unknown) => void>();
  let shown = 0;
  let acks = 0;
  const locks =
    scenario.locks === "missing"
      ? undefined
      : {
          query: async () => {
            if (scenario.locks === "throws") throw new Error("locks unavailable");
            return { held: (scenario.held ?? []).map((name) => ({ name, mode: "shared" })), pending: [] };
          },
        };
  const sandbox: Record<string, unknown> = {
    URL,
    JSON,
    Date,
    atob,
    Uint8Array,
    console,
    fetch: async () => {
      acks += 1;
      return { ok: true };
    },
  };
  sandbox.self = {
    location: { origin: "https://bb.example" },
    navigator: { userAgent: scenario.userAgent ?? CHROME_ANDROID, locks },
    clients: {
      claim: async () => undefined,
      matchAll: async () => scenario.windows ?? [],
    },
    registration: {
      showNotification: async () => {
        shown += 1;
      },
      pushManager: { getSubscription: async () => ({ endpoint: "https://push.example/e" }) },
    },
    skipWaiting: () => undefined,
    addEventListener: (name: string, handler: (event: unknown) => void) => listeners.set(name, handler),
  };
  vm.runInNewContext(
    renderServiceWorker({
      publicKey: "AAAA",
      deliveryPath: "/delivery",
      resubscribePath: "/resubscribe",
      focusLockPrefix: PREFIX,
    }),
    sandbox,
  );
  const pending: Promise<unknown>[] = [];
  listeners.get("push")?.({
    data: { json: () => scenario.payload ?? { title: "t", body: "b", threadId: "thr_a", kind: "turn-finished" } },
    waitUntil: (promise: Promise<unknown>) => pending.push(promise),
  });
  await Promise.all(pending);
  return { shown, acks };
}

const focused = [{ focused: true }];
const viewingA = [`${PREFIX}thr_a`];
const cases: Array<[string, Scenario, boolean]> = [
  ["focused window on the pushed thread: skipped", { windows: focused, held: viewingA }, false],
  ["focused window on another thread: shown", { windows: focused, held: [`${PREFIX}thr_b`] }, true],
  ["lock held but no focused window: shown", { windows: [{ focused: false }], held: viewingA }, true],
  ["no windows open: shown", { windows: [], held: viewingA }, true],
  ["focused window without a lock: shown", { windows: focused, held: [] }, true],
  ["another plugin's lock with the same suffix: shown", { windows: focused, held: ["other-thr_a"] }, true],
  ["push without a thread (test button): shown", { windows: focused, held: viewingA, payload: { title: "t" } }, true],
  ["setting off in the payload: shown", { windows: focused, held: viewingA, payload: { threadId: "thr_a", skipWhenViewing: false } }, true],
  ["setting on in the payload: skipped", { windows: focused, held: viewingA, payload: { threadId: "thr_a", skipWhenViewing: true } }, false],
  ["Web Locks missing: shown", { windows: focused, held: viewingA, locks: "missing" }, true],
  ["Web Locks query throws: shown", { windows: focused, held: viewingA, locks: "throws" }, true],
  ["Chrome on macOS (says Safari/): skipped", { windows: focused, held: viewingA, userAgent: CHROME_MAC }, false],
  ["Safari on macOS: shown", { windows: focused, held: viewingA, userAgent: SAFARI_MAC }, true],
  ["Safari on iOS: shown", { windows: focused, held: viewingA, userAgent: SAFARI_IOS }, true],
];

let failures = 0;
for (const [name, scenario, expectShown] of cases) {
  try {
    const result = await runPush(scenario);
    assert.equal(result.shown, expectShown ? 1 : 0, `notification shown count`);
    assert.equal(result.acks, 1, "the device acknowledges the push either way");
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
if (failures > 0) {
  console.log(`${failures} of ${cases.length} failed`);
  process.exit(1);
}
console.log(`all ${cases.length} service worker cases passed`);
