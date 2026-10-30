// End-to-end test of the plugin's server half against a mock push service.
//
// The mock plays the browser: it holds a real P-256 key pair plus auth secret,
// accepts the encrypted push, verifies the VAPID header, decrypts the body with
// the same RFC 8291 derivation, and prints what it received. Then it posts the
// same delivery ack the service worker posts.
//
// Run against a running bb daemon: `node scripts/test-delivery.ts`.
// Set BB_URL to override http://127.0.0.1:38886.
import { createDecipheriv, createECDH, createPublicKey, createVerify, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import { promisify } from "node:util";
import { deriveKeys, fromBase64Url, toBase64Url } from "../push-crypto.ts";

const BB_URL = process.env.BB_URL ?? "http://127.0.0.1:38886";
const PORT = Number(process.env.PUSH_PORT ?? 45999);
const run = promisify(execFile);

async function bb(args: string[]): Promise<string> {
  const { stdout } = await run("bb", args, { maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

// --- the "browser" -------------------------------------------------------
const browserKeys = createECDH("prime256v1");
browserKeys.generateKeys();
const userAgentPublic = browserKeys.getPublicKey();
const authSecret = randomBytes(16);
const endpoint = `http://127.0.0.1:${PORT}/push/integration-test`;

let received: { body: Buffer; headers: Record<string, string | string[] | undefined> } | null = null;
let announced: () => void;
const arrived = new Promise<void>((resolve) => {
  announced = resolve;
});

let respondGone = false;
const server = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    if (respondGone) {
      // What FCM answers for a subscription the browser has dropped.
      response.writeHead(410).end();
      return;
    }
    received = { body: Buffer.concat(chunks), headers: request.headers };
    response.writeHead(201).end();
    announced();
  });
});
await new Promise<void>((resolve) => server.listen(PORT, "127.0.0.1", resolve));

// --- register, send, inspect --------------------------------------------
await fetch(`${BB_URL}/api/v1/plugins/web-push/http/subscribe`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    endpoint,
    keys: { p256dh: toBase64Url(userAgentPublic), auth: toBase64Url(authSecret) },
    label: "integration test",
    userAgent: "mock-browser/1.0",
  }),
});

const subscriptions = JSON.parse(
  await bb(["web-push", "list", "--json"]),
) as Array<{ id: string; label: string; host: string }>;
const mine = subscriptions.find((row) => row.label === "integration test");
assert.ok(mine !== undefined, "the mock subscription is listed");
assert.equal(mine.host, `127.0.0.1:${PORT}`);

const sendResult = JSON.parse(
  await bb(["web-push", "send", "--title", "Integration title", "--body", "Integration body", "--json"]),
) as { sent: number; failed: number; pruned: number };
// Other browsers may be subscribed on this server; the mock proves its own copy.
assert.ok(sendResult.sent >= 1, `expected at least one delivery, got ${JSON.stringify(sendResult)}`);

await Promise.race([
  arrived,
  new Promise((_, reject) => setTimeout(() => reject(new Error("no push arrived")), 15_000)),
]);
assert.ok(received !== null, "the mock push service received a request");
const push = received as unknown as {
  body: Buffer;
  headers: Record<string, string | string[] | undefined>;
};

// Headers a real push service enforces.
assert.equal(push.headers["content-encoding"], "aes128gcm");
assert.equal(push.headers["content-type"], "application/octet-stream");
assert.equal(push.headers.ttl, "86400");
assert.equal(push.headers.urgency, "high");
const authorization = String(push.headers.authorization ?? "");
const vapid = /^vapid t=([^,]+), k=(.+)$/u.exec(authorization);
assert.ok(vapid !== null, "Authorization is a VAPID header");

const [encodedHeader, encodedClaims, encodedSignature] = vapid[1].split(".");
const claims = JSON.parse(fromBase64Url(encodedClaims).toString("utf8"));
assert.equal(claims.aud, `http://127.0.0.1:${PORT}`, "VAPID aud is the endpoint origin");
assert.ok(claims.exp > Date.now() / 1000, "VAPID exp is in the future");
assert.ok(typeof claims.sub === "string" && claims.sub.length > 0, "VAPID sub is set");

// The advertised key must be the key that signed the token, and it must be an
// uncompressed P-256 point.
const advertised = fromBase64Url(vapid[2]);
assert.equal(advertised.length, 65);
assert.equal(advertised[0], 0x04);
assert.ok(
  createVerify("sha256")
    .update(`${encodedHeader}.${encodedClaims}`)
    .verify(
      { key: keyFromUncompressed(advertised), dsaEncoding: "ieee-p1363" },
      fromBase64Url(encodedSignature),
    ),
  "VAPID signature verifies against the advertised key",
);

// Decrypt exactly like a browser.
const salt = push.body.subarray(0, 16);
const recordSize = push.body.readUInt32BE(16);
const keyIdLength = push.body[20];
const applicationServerPublic = push.body.subarray(21, 21 + keyIdLength);
const ciphertext = push.body.subarray(21 + keyIdLength);
assert.equal(recordSize, 4096);
assert.equal(keyIdLength, 65);
// The body carries the per-message ephemeral key, deliberately not the VAPID
// key: a browser derives its shared secret from this point only.
assert.equal(applicationServerPublic.length, 65);
assert.equal(applicationServerPublic[0], 0x04);
assert.ok(!applicationServerPublic.equals(advertised), "the ephemeral key is distinct from the VAPID key");

const ecdhSecret = browserKeys.computeSecret(applicationServerPublic);
const { contentEncryptionKey, nonce } = deriveKeys({
  ecdhSecret,
  authSecret,
  userAgentPublic,
  applicationServerPublic,
  salt,
});
const decipher = createDecipheriv("aes-128-gcm", contentEncryptionKey, nonce);
// aes128gcm appends the 16-byte GCM tag, which node wants passed separately.
const tag = ciphertext.subarray(ciphertext.length - 16);
decipher.setAuthTag(tag);
const plaintext = Buffer.concat([
  decipher.update(ciphertext.subarray(0, ciphertext.length - 16)),
  decipher.final(),
]);
const padStart = plaintext.lastIndexOf(0x02);
assert.ok(padStart > 0, "the record is padded with 0x02");
const payload = JSON.parse(plaintext.subarray(0, padStart).toString("utf8")) as Record<string, unknown>;
assert.equal(payload.title, "Integration title");
assert.equal(payload.body, "Integration body");
assert.equal(payload.threadId, null);

// The service worker's ack path.
await fetch(`${BB_URL}/api/v1/plugins/web-push/http/delivery`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ endpoint, shownAt: Date.now() }),
});
const afterAck = JSON.parse(await bb(["web-push", "list", "--json"])) as Array<{
  id: string;
  lastDelivered: string | null;
}>;
const deliveredRow = afterAck.find((row) => row.id === mine.id);
assert.ok(deliveredRow !== undefined && deliveredRow.lastDelivered !== null, "the ack records delivery");

// A subscription the push service reports gone must prune itself.
respondGone = true;
await run("bb", ["web-push", "test", "--json"]).catch(() => undefined);
await new Promise<void>((resolve) => server.close(() => resolve()));

const remaining = JSON.parse(await bb(["web-push", "list", "--json"])) as Array<{ id: string }>;
assert.equal(
  remaining.filter((row) => row.id === mine.id).length,
  0,
  "a subscription the push service rejects is removed",
);

console.log("delivery: encrypted push, VAPID header, ack, and pruning all pass");
console.log(`  decrypted payload: ${JSON.stringify(payload)}`);

function keyFromUncompressed(uncompressed: Buffer) {
  // Node takes DER or JWK, so wrap the raw point in a P-256 SPKI header.
  const prefix = Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex");
  return createPublicKey({
    key: Buffer.concat([prefix, uncompressed]),
    format: "der",
    type: "spki",
  });
}
