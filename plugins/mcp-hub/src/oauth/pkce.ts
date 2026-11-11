import { createHash, randomBytes } from "node:crypto";

/**
 * One authorization attempt's secrets.
 *
 * `verifier` and `state` are both 32 random bytes rather than a shorter id
 * because they carry the whole weight of the flow's security: the verifier is
 * what proves to the token endpoint that the code came back to the client that
 * asked for it, and `state` is the ONLY protection the callback route has -
 * that route is `auth: "none"` because a browser redirect from Notion carries
 * neither a BB app origin nor a plugin token, so anything guessable there is a
 * way to feed this plugin someone else's authorization code.
 *
 * 32 bytes base64url is 43 characters, which is also exactly RFC 7636's
 * minimum verifier length, so one size satisfies both jobs.
 */
export function createPkce(): { verifier: string; challenge: string; state: string } {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    // S256 only. RFC 7636's "plain" method offers no protection at all
    // against an attacker who can read the authorize request.
    challenge: createHash("sha256").update(verifier).digest("base64url"),
    state: randomBytes(32).toString("base64url"),
  };
}
