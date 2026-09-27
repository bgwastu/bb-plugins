import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  definePluginApp,
  useRealtime,
  useRpc,
  useBbNavigate,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { UsagiBoardData } from "./lib/types";
import { PROVIDER_META } from "./lib/types";
import { AccountTile } from "./components/account-tile";
import { ProviderIcon, RabbitIcon } from "./components/provider-icons";
import { MeterBar } from "./components/meter-bar";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Icon } from "./components/ui/icon";
import { cn } from "./lib/utils";

/** Hook to fetch and maintain live Usagi board state */
function useUsagiBoard() {
  const rpc = useRpc<typeof rpcContract>();
  const [board, setBoard] = useState<UsagiBoardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchUsage = useCallback(
    async (force = false) => {
      try {
        if (force) setRefreshing(true);
        const res = await rpc.call("usagi_get_usage", { force });
        if (res.ok && res.data) {
          setBoard(res.data);
          setError(null);
        } else if (res.error) {
          setError(res.error);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [rpc],
  );

  useEffect(() => {
    fetchUsage(false);
  }, [fetchUsage]);

  useRealtime("usagi:updated", () => {
    fetchUsage(false);
  });

  return { board, loading, refreshing, error, refetch: () => fetchUsage(true) };
}

/** Header Actions rendered directly in BB's native top title bar */
function UsagiHeaderActions() {
  const { refreshing, refetch } = useUsagiBoard();
  const { values: settingsValues } = useSettings();
  const endpoint = typeof settingsValues?.endpoint === "string" ? settingsValues.endpoint.trim() : "";
  let dashboardUrl = "";
  try {
    const parsed = new URL(endpoint);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      parsed.pathname = parsed.pathname.replace(/\/api\/?$/, "") || "/";
      parsed.search = "";
      parsed.hash = "";
      dashboardUrl = parsed.toString();
    }
  } catch {}

  return (
    <div className="flex items-center gap-1.5">
      <Button
        variant="ghost"
        size="sm"
        onClick={refetch}
        disabled={refreshing}
        className="h-8 gap-1.5 px-2.5 text-xs font-medium text-muted-foreground hover:text-foreground [&_svg]:size-3.5"
        aria-label="Refresh quotas"
      >
        <Icon
          name="RotateCcw"
          className={cn("size-3.5", refreshing && "animate-spin")}
        />
        <span className="hidden sm:inline">Refresh</span>
      </Button>

      {dashboardUrl ? (
        <Button
          variant="ghost"
          size="sm"
          asChild
          className="h-8 gap-1.5 px-2.5 text-xs font-medium text-muted-foreground hover:text-foreground [&_svg]:size-3.5"
        >
          <a
            href={dashboardUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open Usagi Web Board"
          >
            <Icon name="ExternalLink" className="size-3.5" />
            <span className="hidden sm:inline">Web Board</span>
          </a>
        </Button>
      ) : null}
    </div>
  );
}

/** Dashboard Page for Nav Panel (no duplicate headers) */
function UsagiDashboardPage() {
  const { board, loading, refreshing, error, refetch } = useUsagiBoard();
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedProvider, setSelectedProvider] = useState<string>("all");

  const accounts = useMemo(() => board?.accounts ?? [], [board]);

  // Provider list with account counts
  const providerCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of accounts) {
      const p = item.account.provider;
      map.set(p, (map.get(p) ?? 0) + 1);
    }
    return map;
  }, [accounts]);

  // Filtered accounts list
  const filteredAccounts = useMemo(() => {
    return accounts.filter((item) => {
      const p = item.account.provider;
      if (selectedProvider !== "all" && p !== selectedProvider) {
        return false;
      }
      if (!searchQuery.trim()) return true;
      const q = searchQuery.toLowerCase();
      const meta = PROVIDER_META[p];
      return (
        item.account.name.toLowerCase().includes(q) ||
        p.toLowerCase().includes(q) ||
        (meta && meta.displayName.toLowerCase().includes(q))
      );
    });
  }, [accounts, selectedProvider, searchQuery]);

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto bg-background/50">
      <div className="mx-auto box-border w-full max-w-6xl space-y-3 px-3.5 pb-8 pt-3 md:px-5">
        {error ? (
          <div className="flex items-center gap-2 rounded-lg border border-destructive/20 bg-destructive/10 p-2.5 text-xs text-destructive">
            <Icon name="AlertTriangle" className="size-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        {/* Compact Filter Chips & Search Bar */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-1">
            <button
              type="button"
              onClick={() => setSelectedProvider("all")}
              className={`inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors ${
                selectedProvider === "all"
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted/70 text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              All ({accounts.length})
            </button>
            {Array.from(providerCounts.entries()).map(([prov, count]) => {
              const meta = PROVIDER_META[prov];
              const isSelected = selectedProvider === prov;
              return (
                <button
                  key={prov}
                  type="button"
                  onClick={() => setSelectedProvider(prov)}
                  className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium transition-colors ${
                    isSelected
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted/70 text-muted-foreground hover:bg-muted hover:text-foreground"
                  }`}
                >
                  <ProviderIcon provider={prov} size={12} />
                  <span>{meta?.displayName ?? prov}</span>
                  <span className="font-mono text-[10px] opacity-70">({count})</span>
                </button>
              );
            })}
          </div>

          <div className="relative w-full sm:w-56">
            <Icon
              name="Search"
              className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              type="search"
              placeholder="Search accounts or models..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-8 pl-8 pr-2.5 text-xs"
            />
          </div>
        </div>

        {/* Compact Accounts Grid */}
        {loading && !board ? (
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
            {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
              <div
                key={i}
                className="h-28 rounded-lg border border-border/60 bg-card p-3 animate-pulse"
              >
                <div className="flex items-center gap-2">
                  <div className="size-6.5 rounded bg-muted" />
                  <div className="flex-1 space-y-1">
                    <div className="h-2.5 w-16 rounded bg-muted" />
                    <div className="h-2 w-24 rounded bg-muted/60" />
                  </div>
                </div>
                <div className="mt-3 space-y-1.5">
                  <div className="h-1.5 w-full rounded bg-muted/70" />
                  <div className="h-1.5 w-3/4 rounded bg-muted/50" />
                </div>
              </div>
            ))}
          </div>
        ) : filteredAccounts.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-8 text-center">
            <p className="text-xs text-muted-foreground">
              {searchQuery
                ? `No accounts found matching "${searchQuery}".`
                : "No accounts found for this provider filter."}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
            {filteredAccounts.map((item) => (
              <AccountTile key={item.account.id} item={item} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}


/** Homepage Section */
function UsagiHomepageSection() {
  const { board, loading } = useUsagiBoard();
  const { values: settingsValues } = useSettings();
  const navigate = useBbNavigate();
  const accounts = board?.accounts ?? [];

  const showCard =
    settingsValues?.showHomepageCard !== false; // default on
  if (!showCard) {
    return null;
  }

  if (loading && !board) {
    return (
      <div className="rounded-lg border border-border bg-card p-3 animate-pulse">
        <div className="h-3.5 w-28 rounded bg-muted" />
      </div>
    );
  }

  // Highlight top 4 accounts
  const previewAccounts = accounts.slice(0, 4);

  return (
    <div className="rounded-lg border border-border bg-card p-3 shadow-2xs">
      <div className="flex items-center justify-between border-b border-border/50 pb-2">
        <div className="flex items-center gap-1.5">
          <RabbitIcon size={14} className="text-primary" />
          <span className="text-xs font-semibold text-foreground">Usagi</span>
        </div>
        <button
          type="button"
          onClick={() => navigate.toPluginPanel("usage")}
          className="text-xs font-medium text-primary hover:underline"
        >
          View all →
        </button>
      </div>

      <div className="mt-2.5 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {previewAccounts.map((item) => {
          const acc = item.account;
          const u = item.usage;
          const primaryMeter = u?.meters?.[0];
          return (
            <div
              key={acc.id}
              className="flex flex-col justify-between rounded-md border border-border/60 bg-muted/20 p-2 text-xs"
            >
              <div className="mb-1 flex items-center justify-between gap-1">
                <div className="flex min-w-0 items-center gap-1.5">
                  <ProviderIcon provider={acc.provider} size={13} />
                  <span className="truncate text-[11px] font-medium text-foreground">
                    {PROVIDER_META[acc.provider]?.displayName ?? acc.provider}
                  </span>
                </div>
                {u?.plan ? (
                  <span className="shrink-0 text-[9px] uppercase text-muted-foreground">
                    {u.plan}
                  </span>
                ) : null}
              </div>

              {primaryMeter ? (
                <MeterBar meter={primaryMeter} compact />
              ) : (
                <span className="text-[10px] text-muted-foreground">No active meters</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Thread Right Panel View */
function UsagiThreadPanel() {
  const { board, loading, refreshing, refetch } = useUsagiBoard();
  const [filter, setFilter] = useState("");
  const accounts = board?.accounts ?? [];

  const filtered = accounts.filter(
    (a) =>
      !filter ||
      a.account.name.toLowerCase().includes(filter.toLowerCase()) ||
      a.account.provider.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <div className="flex h-full flex-col overflow-y-auto p-3 space-y-2.5">
      <div className="flex items-center justify-between gap-2 border-b border-border pb-2">
        <div className="flex items-center gap-1.5">
          <RabbitIcon size={15} className="text-primary" />
          <span className="text-xs font-semibold text-foreground">AI Quota Status</span>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={refetch}
          disabled={refreshing}
          className="size-8 shrink-0 [&_svg]:size-3.5"
          aria-label="Refresh quotas"
        >
          <Icon
            name="RotateCcw"
            className={cn("size-3.5", refreshing && "animate-spin")}
          />
        </Button>
      </div>

      <div className="relative">
        <Icon
          name="Search"
          className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          type="search"
          placeholder="Filter..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="h-8 pl-8 pr-2 text-xs"
        />
      </div>

      <div className="space-y-2 overflow-y-auto">
        {filtered.map((item) => (
          <AccountTile key={item.account.id} item={item} compact />
        ))}
      </div>
    </div>
  );
}

/** Plugin Settings Section */
function UsagiSettingsSection() {
  const { board, loading, refetch } = useUsagiBoard();
  return (
    <div className="space-y-2.5 rounded-lg border border-border p-3 text-xs text-muted-foreground">
      <div className="flex items-center justify-between">
        <div>
          <h4 className="font-semibold text-foreground">Usagi Service Status</h4>
          <p className="text-xs">
            {board
              ? `Connected · ${board.accounts.length} accounts reporting live`
              : loading
                ? "Connecting..."
                : "Unable to reach Usagi API"}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={refetch}>
          Test Connection
        </Button>
      </div>
    </div>
  );
}

// Plugin Frontend Registration
export default definePluginApp((app) => {
  // Main Nav Panel
  app.slots.navPanel({
    id: "usagi-nav",
    title: "Usagi",
    icon: "Rabbit",
    path: "usage",
    component: UsagiDashboardPage,
    headerContent: UsagiHeaderActions,
  });

  // Homepage widget. The host always renders the section title above the
  // component and rejects empty strings, so use a zero-width space to keep it
  // invisible; the card itself draws its own header.
  app.slots.homepageSection({
    id: "usagi-homepage",
    title: "\u200b",
    component: UsagiHomepageSection,
  });

  // Thread panel action (accessible inside existing threads)
  app.slots.threadPanelAction({
    id: "usagi-quota-panel",
    title: "Usagi",
    icon: "Rabbit",
    component: UsagiThreadPanel,
    run: ({ openPanel }) => {
      openPanel({ title: "Usagi" });
    },
  });

  // Root New Thread panel action
  app.slots.experimental_newThreadPanelAction({
    id: "usagi-new-thread-quota",
    title: "Usagi",
    icon: "Rabbit",
    component: UsagiThreadPanel,
    run: ({ openPanel }) => {
      openPanel({ title: "Usagi" });
    },
  });

  // Settings Section on plugin detail page
  app.slots.settingsSection({
    id: "usagi-settings",
    title: "Usagi Connection",
    description: "Verify connection to the Usagi usage endpoint.",
    component: UsagiSettingsSection,
  });
});
