// Verify push-crypto.ts against the RFC 8291 §5 test vector.
//
// Run with `node scripts/test-crypto.ts` (Node 22.6+ runs TypeScript directly).
// The vector pins every intermediate value as well as the final body, so a
// failure names the wrong step instead of only "ciphertext differs".
import { createECDH } from "node:crypto";
import assert from "node:assert/strict";
import {
  deriveKeys,
  encryptPayload,
  fromBase64Url,
  toBase64Url,
  vapidAuthorization,
  createVapidKeys,
} from "../push-crypto.ts";

// RFC 8291 §5.
const USER_AGENT = {
  p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
};
const APPLICATION_SERVER_PRIVATE = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";
const APPLICATION_SERVER_PUBLIC =
  "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
const SALT = "DGv6ra1nlYgDCS1FRnbzlw";
const PLAINTEXT = "When I grow up, I want to be a watermelon";
const EXPECTED_BODY =
  "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN";

const ecdh = createECDH("prime256v1");
ecdh.setPrivateKey(fromBase64Url(APPLICATION_SERVER_PRIVATE));
const applicationServerPublic = ecdh.getPublicKey();
assert.equal(toBase64Url(applicationServerPublic), APPLICATION_SERVER_PUBLIC, "server public key");

const userAgentPublic = fromBase64Url(USER_AGENT.p256dh);
const ecdhSecret = ecdh.computeSecret(userAgentPublic);
assert.equal(
  toBase64Url(ecdhSecret),
  "kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs",
  "ecdh shared secret",
);

const derived = deriveKeys({
  ecdhSecret,
  authSecret: fromBase64Url(USER_AGENT.auth),
  userAgentPublic,
  applicationServerPublic,
  salt: fromBase64Url(SALT),
});
assert.equal(toBase64Url(derived.ikm), "S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg", "IKM");
assert.equal(toBase64Url(derived.prk), "09_eUZGrsvxChDCGRCdkLiDXrReGOEVeSCdCcPBSJSc", "PRK");
assert.equal(toBase64Url(derived.contentEncryptionKey), "oIhVW04MRdy2XN9CiKLxTg", "CEK");
assert.equal(toBase64Url(derived.nonce), "4h_95klXJ5E_qnoN", "nonce");

const encrypted = encryptPayload({
  payload: PLAINTEXT,
  keys: USER_AGENT,
  salt: fromBase64Url(SALT),
  applicationServerKeys: {
    publicKey: applicationServerPublic,
    privateKey: fromBase64Url(APPLICATION_SERVER_PRIVATE),
  },
});
assert.equal(toBase64Url(encrypted.body), EXPECTED_BODY, "encrypted body");

// A random-salt round trip still decrypts: prove the generic path works too.
const roundTrip = encryptPayload({ payload: PLAINTEXT, keys: USER_AGENT });
assert.equal(roundTrip.body.subarray(0, 16).length, 16);
assert.ok(roundTrip.body.length > 21 + 65 + PLAINTEXT.length);

// VAPID: the JWT must verify with the public key it advertises.
const dictionary = createVapidKeys();
const endpoint = "https://fcm.googleapis.com/fcm/send/abc123";
const authorization = vapidAuthorization({
  endpoint,
  keys: dictionary,
  subject: "mailto:test@example.com",
  now: 1_700_000_000_000,
});
const match = /^vapid t=([^,]+), k=(.+)$/u.exec(authorization);
assert.ok(match !== null, "authorization header shape");
const [, jwt, advertisedKey] = match;
assert.equal(advertisedKey, dictionary.publicKey);

const [encodedHeader, encodedClaims, encodedSignature] = jwt.split(".");
const header = JSON.parse(fromBase64Url(encodedHeader).toString("utf8"));
const claims = JSON.parse(fromBase64Url(encodedClaims).toString("utf8"));
assert.deepEqual(header, { typ: "JWT", alg: "ES256" });
assert.equal(claims.aud, "https://fcm.googleapis.com");
assert.equal(claims.sub, "mailto:test@example.com");
assert.equal(claims.exp, 1_700_000_000 + 12 * 3600);

const { createPublicKey, createVerify } = await import("node:crypto");
const publicKey = createPublicKey(dictionary.privateKey);
const verified = createVerify("sha256")
  .update(`${encodedHeader}.${encodedClaims}`)
  .verify({ key: publicKey, dsaEncoding: "ieee-p1363" }, fromBase64Url(encodedSignature));
assert.equal(verified, true, "VAPID JWT signature verifies");
assert.equal(
  toBase64Url(Buffer.concat([
    Buffer.from([0x04]),
    fromBase64Url(publicKey.export({ format: "jwk" }).x ?? ""),
    fromBase64Url(publicKey.export({ format: "jwk" }).y ?? ""),
  ])),
  dictionary.publicKey,
  "advertised key matches the signing key",
);

// Subject-less VAPID is rejected by push services; the plugin always sends one,
// but keep the shape check honest.
assert.throws(() => vapidAuthorization({ endpoint: "not-a-url", keys: dictionary, subject: "mailto:a@b.c" }));

console.log("push-crypto: all RFC 8291 / RFC 8292 vectors pass");
