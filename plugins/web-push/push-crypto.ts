// Web Push wire format: VAPID (RFC 8292) + aes128gcm payload encryption
// (RFC 8291 / RFC 8188), implemented on node:crypto so the plugin has no
// runtime dependency beyond the standard library.
//
// Pure functions, Buffer in / Buffer out: scripts/test-crypto.ts exercises
// them against the RFC 8291 section 5 test vector.
import {
  createCipheriv,
  createECDH,
  createHmac,
  createSign,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from "node:crypto";

/** Uncompressed P-256 point (65 bytes) as PushSubscription gives it. */
export type PushKeys = { p256dh: string; auth: string };

const RECORD_SIZE = 4096;
const PAD_DELIMITER = 0x02;

export function toBase64Url(value: Buffer): string {
  return value.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

export function fromBase64Url(value: string): Buffer {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

/** RFC 5869 HKDF-Expand, single block set (outputs shorter than 255*32). */
export function hkdfExpand(prk: Buffer, info: Buffer, length: number): Buffer {
  const blocks: Buffer[] = [];
  let previous = Buffer.alloc(0);
  let produced = 0;
  for (let counter = 1; produced < length; counter += 1) {
    const hmac = createHmac("sha256", prk);
    hmac.update(previous);
    hmac.update(info);
    hmac.update(Buffer.from([counter]));
    previous = hmac.digest();
    blocks.push(previous);
    produced += previous.length;
  }
  return Buffer.concat(blocks).subarray(0, length);
}

/** RFC 8291 §3.4 key derivation for one aes128gcm record. */
export function deriveKeys(input: {
  ecdhSecret: Buffer;
  authSecret: Buffer;
  userAgentPublic: Buffer;
  applicationServerPublic: Buffer;
  salt: Buffer;
}) {
  const authInfo = Buffer.concat([
    Buffer.from("WebPush: info\0", "ascii"),
    input.userAgentPublic,
    input.applicationServerPublic,
  ]);
  const ikm = Buffer.from(
    hkdfSync("sha256", input.ecdhSecret, input.authSecret, authInfo, 32),
  );
  const prk = createHmac("sha256", input.salt).update(ikm).digest();
  const contentEncryptionKey = hkdfExpand(
    prk,
    Buffer.from("Content-Encoding: aes128gcm\0", "ascii"),
    16,
  );
  const nonce = hkdfExpand(prk, Buffer.from("Content-Encoding: nonce\0", "ascii"), 12);
  return { ikm, prk, contentEncryptionKey, nonce };
}

/** Encrypt one push message; returns the HTTP body for the push service. */
export function encryptPayload(input: {
  payload: string | Buffer;
  keys: PushKeys;
  /** Caller-supplied so tests can pin the RFC vector. */
  salt?: Buffer;
  applicationServerKeys?: { publicKey: Buffer; privateKey: Buffer };
}): { body: Buffer; salt: Buffer; applicationServerPublic: Buffer; ecdhSecret: Buffer } {
  const userAgentPublic = fromBase64Url(input.keys.p256dh);
  const authSecret = fromBase64Url(input.keys.auth);
  const salt = input.salt ?? randomBytes(16);

  const ecdh = createECDH("prime256v1");
  if (input.applicationServerKeys === undefined) {
    ecdh.generateKeys();
  } else {
    ecdh.setPrivateKey(input.applicationServerKeys.privateKey);
  }
  const applicationServerPublic = ecdh.getPublicKey();
  if (
    input.applicationServerKeys !== undefined &&
    !applicationServerPublic.equals(input.applicationServerKeys.publicKey)
  ) {
    throw new Error("application server key pair does not match");
  }
  const ecdhSecret = ecdh.computeSecret(userAgentPublic);

  const { contentEncryptionKey, nonce } = deriveKeys({
    ecdhSecret,
    authSecret,
    userAgentPublic,
    applicationServerPublic,
    salt,
  });

  const plaintext = Buffer.concat([
    Buffer.isBuffer(input.payload) ? input.payload : Buffer.from(input.payload, "utf8"),
    Buffer.from([PAD_DELIMITER]),
  ]);
  const cipher = createCipheriv("aes-128-gcm", contentEncryptionKey, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);

  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(RECORD_SIZE, 0);
  const keyIdLength = Buffer.from([applicationServerPublic.length]);
  const body = Buffer.concat([
    salt,
    recordSize,
    keyIdLength,
    applicationServerPublic,
    ciphertext,
  ]);

  return { body, salt, applicationServerPublic, ecdhSecret };
}

export type VapidKeys = {
  /** Raw uncompressed public key, base64url: `applicationServerKey` and the `k=` parameter. */
  publicKey: string;
  /** PKCS#8 PEM, the form node:crypto signs with. */
  privateKey: string;
};

export function createVapidKeys(): VapidKeys {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const raw = publicKey.export({ format: "jwk" }).x ?? "";
  const y = publicKey.export({ format: "jwk" }).y ?? "";
  const uncompressed = Buffer.concat([
    Buffer.from([0x04]),
    fromBase64Url(raw),
    fromBase64Url(y),
  ]);
  return {
    publicKey: toBase64Url(uncompressed),
    privateKey: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  };
}

/**
 * `Authorization` header value for one push service endpoint (RFC 8292 §3):
 * an ES256 JWT whose `aud` is the endpoint's origin, plus the public key.
 */
export function vapidAuthorization(input: {
  endpoint: string;
  keys: VapidKeys;
  subject: string;
  expiresInSeconds?: number;
  now?: number;
}): string {
  const endpoint = new URL(input.endpoint);
  const header = { typ: "JWT", alg: "ES256" };
  const claims = {
    aud: endpoint.origin,
    exp: Math.floor((input.now ?? Date.now()) / 1000) + (input.expiresInSeconds ?? 12 * 3600),
    sub: input.subject,
  };
  const signingInput = `${toBase64Url(Buffer.from(JSON.stringify(header), "utf8"))}.${toBase64Url(
    Buffer.from(JSON.stringify(claims), "utf8"),
  )}`;
  const signature = createSign("sha256")
    .update(signingInput)
    .sign({ key: input.keys.privateKey, dsaEncoding: "ieee-p1363" });
  const jwt = `${signingInput}.${toBase64Url(signature)}`;
  return `vapid t=${jwt}, k=${input.keys.publicKey}`;
}

/** Push service status codes that mean "this subscription is dead". */
export function isGoneStatus(status: number): boolean {
  return status === 404 || status === 410;
}
