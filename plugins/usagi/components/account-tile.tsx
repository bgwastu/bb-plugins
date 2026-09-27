import React, { useState } from "react";
import type { UsagiAccountItem, UsagiMeter } from "../lib/types";
import { PROVIDER_META } from "../lib/types";
import { ProviderIcon } from "./provider-icons";
import { MeterBar } from "./meter-bar";
import { Icon } from "./ui/icon";

type AccountTileProps = {
  item: UsagiAccountItem;
  compact?: boolean;
};

export function AccountTile({ item, compact = false }: AccountTileProps) {
  const { account, usage } = item;
  const meta = PROVIDER_META[account.provider] ?? {
    displayName: account.provider.charAt(0).toUpperCase() + account.provider.slice(1),
    description: "",
  };

  const [expandedDetails, setExpandedDetails] = useState(false);

  const meters = usage?.meters ?? [];
  const detailMeters = usage?.detailMeters ?? [];
  const hasDetails = detailMeters.length > 0;

  return (
    <div className="group flex flex-col justify-between rounded-lg border border-border/70 bg-card p-3 text-card-foreground shadow-2xs transition-all hover:border-border hover:shadow-xs">
      <div>
        {/* Compact Header */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <div className="flex size-6.5 shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted/40 text-foreground transition-colors group-hover:bg-muted">
              <ProviderIcon provider={account.provider} size={15} />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-xs font-semibold tracking-tight text-foreground">
                  {meta.displayName}
                </span>
                {usage?.plan ? (
                  <span className="inline-flex shrink-0 items-center rounded border border-border/80 bg-muted/60 px-1 text-[9px] font-medium tracking-wide text-muted-foreground uppercase">
                    {usage.plan}
                  </span>
                ) : null}
              </div>
              <p className="truncate text-[10.5px] leading-tight text-muted-foreground" title={account.name}>
                {account.name}
              </p>
            </div>
          </div>

          {account.authStatus === "reauth_required" ? (
            <span className="inline-flex shrink-0 items-center rounded border border-rose-500/20 bg-rose-500/10 px-1 text-[9px] font-medium text-rose-500">
              Reauth
            </span>
          ) : null}
        </div>

        {/* Status / Error */}
        {usage?.status === "error" ? (
          <div className="mt-2 rounded border border-rose-500/20 bg-rose-500/10 p-1.5 text-[11px] text-rose-500">
            {usage.error || "Failed to fetch usage"}
          </div>
        ) : null}

        {/* Compact Meters List */}
        {meters.length > 0 ? (
          <div className="mt-2.5 flex flex-col gap-2">
            {meters.map((meter) => (
              <MeterBar key={meter.id} meter={meter} compact={compact} />
            ))}
          </div>
        ) : !usage ? (
          <div className="mt-2 text-[11px] text-muted-foreground">No usage reported</div>
        ) : null}

        {/* Expandable Model Breakdown */}
        {hasDetails && !compact ? (
          <div className="mt-2 border-t border-border/50 pt-1.5">
            <button
              type="button"
              onClick={() => setExpandedDetails(!expandedDetails)}
              className="flex w-full items-center justify-between py-0.5 text-[10.5px] font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              <span>{expandedDetails ? "Hide breakdown" : `${detailMeters.length} models`}</span>
              <Icon
                name={expandedDetails ? "ArrowDown" : "ArrowRight"}
                className="size-3 text-muted-foreground"
              />
            </button>

            {expandedDetails ? (
              <div className="mt-1.5 max-h-48 space-y-1.5 overflow-y-auto pr-1">
                {detailMeters.map((m) => (
                  <MeterBar key={m.id} meter={m} compact />
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
