// The plugin's background work.
//
// There is exactly one piece of it, and the shape is deliberate: a durable
// cron schedule rather than a long-lived service. BB gives a service five
// seconds to observe an abort and stop, so a service is a standing liability
// on every reload; a schedule is a function BB calls while the plugin is
// loaded and nothing to unwind. Nothing here needs to hold state between
// runs, so nothing here is a service.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Catalog } from "../catalog.js";

/**
 * How often the cached catalog is re-read from the servers.
 *
 * Every 17 minutes rather than every 15: a prime-ish offset keeps this from
 * lining up with whatever else on the machine fires on a quarter hour, and
 * MCP tool lists change on the timescale of a server release, not a minute.
 * Cron's minute resolution is plenty.
 */
const CATALOG_REFRESH_CRON = "*/17 * * * *";

/** The durable row's key, also the name `bb plugin list` shows. */
const CATALOG_REFRESH_NAME = "catalog-refresh";

export interface ServiceDeps {
  catalog: Catalog;
  /**
   * Registers whatever the refresh discovered. Called once after the whole
   * sweep rather than per server: `registerCatalogTools` reads the whole
   * catalog anyway, so per-server calls would be the same work repeated.
   */
  onCatalogChanged(): void;
  /**
   * Refreshes every remote server's access token that is near expiry.
   *
   * Runs before the catalog sweep, and its real job is not the tokens - the
   * transport keeps those fresh on its own now. It is to find out that a
   * REFRESH has stopped working while there is still nobody waiting on an
   * answer, so a grant an authorization server ended overnight is recorded
   * and shown within seventeen minutes rather than discovered by whatever
   * tool call happens to be first in the morning.
   */
  warmTokens(): Promise<void>;
}

/**
 * Registers the background catalog refresh.
 *
 * There is still no long-lived token-refresh service, and there is still no
 * need for one. A token goes stale inside `OAuthFlow.accessToken`, which the
 * HTTP transport now calls on every request, so a live connection carries a
 * live bearer without anything here intervening - which is also why the old
 * caveat about a write failing once against an idle pooled client no longer
 * applies. What this pass adds is not freshness but VISIBILITY: refreshing on
 * a schedule is how a dead grant becomes a recorded, surfaced auth error
 * instead of a 401 nobody reads.
 */
export function registerServices(bb: BbPluginApi, deps: ServiceDeps): void {
  bb.background.schedule(CATALOG_REFRESH_NAME, CATALOG_REFRESH_CRON, async () => {
    // Never fatal: a warm-up that throws must not cost the catalog its
    // refresh, and every failure it cares about is recorded on the way past.
    try {
      await deps.warmTokens();
    } catch {
      // `onAuthFailure` has already said whatever there was to say.
    }
    // `syncAll` swallows per-server failures after logging them, so one
    // unreachable server never costs the others their refresh. Anything that
    // escapes it is a bug worth surfacing in `bb plugin list`.
    await deps.catalog.syncAll();
    deps.onCatalogChanged();
  });
}
