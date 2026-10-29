// bb-plugin-plain-copy has no server behavior; bb still requires a server
// entry, so this factory registers nothing.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export default function definePlugin(_bb: BbPluginApi): void {
  // no server-side surface
}
