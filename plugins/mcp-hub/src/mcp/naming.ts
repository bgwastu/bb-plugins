// Tool names the model sees. Always `<server>_<tool>`, so a name says where it
// comes from and two servers can never collide. Once assigned, a name is
// stored and never recomputed.
import { createHash } from "node:crypto";

/**
 * BB accepts `[a-zA-Z0-9_-]+`. Providers cap tool names at 64 characters and
 * Claude Code spends 16 of them on its `mcp__bb-bridge__` prefix.
 */
export const MAX_TOOL_NAME = 48;

function clean(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
}

/** A server id from a display name: lowercase, `[a-z0-9-]`, never empty. */
export function slugify(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.slice(0, 24).replace(/-+$/g, "") || "server";
}

/** The first of `base`, `base-2`, `base-3`... that `taken` does not hold. */
export function uniqueId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let index = 2; ; index += 1) {
    const candidate = `${base}-${index}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * `<server>_<tool>`, shortened with a hash suffix rather than cut blind when
 * it would be too long, so two long names never truncate to the same thing.
 */
export function toolName(serverId: string, upstreamName: string, taken: ReadonlySet<string>): string {
  const full = `${clean(serverId)}_${clean(upstreamName) || "tool"}`;
  let name = full;
  if (full.length > MAX_TOOL_NAME) {
    const digest = createHash("sha256").update(`${serverId}\n${upstreamName}`).digest("hex").slice(0, 6);
    name = `${full.slice(0, MAX_TOOL_NAME - 7).replace(/_+$/g, "")}_${digest}`;
  }
  if (!taken.has(name)) return name;
  for (let index = 2; ; index += 1) {
    const suffix = `_${index}`;
    const candidate = `${name.slice(0, MAX_TOOL_NAME - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}
