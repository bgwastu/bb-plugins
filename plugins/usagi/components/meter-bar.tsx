import React from "react";
import type { UsagiMeter } from "../lib/types";
import {
  clampPercent,
  remainingPercent,
  formatResetCountdown,
  meterFillColor,
} from "../lib/format";

type MeterBarProps = {
  meter: UsagiMeter;
  compact?: boolean;
};

export function MeterBar({ meter, compact = false }: MeterBarProps) {
  const isWindow = meter.kind === "window";
  const hasLimit = meter.limit != null && meter.limit > 0;

  // Compute used & remaining percentage
  let usedPct: number | null = null;
  if (meter.usedPercent != null) {
    usedPct = clampPercent(meter.usedPercent);
  } else if (hasLimit && meter.remaining != null) {
    usedPct = clampPercent(((meter.limit! - meter.remaining) / meter.limit!) * 100);
  } else if (hasLimit && meter.used != null) {
    usedPct = clampPercent((meter.used / meter.limit!) * 100);
  }

  const remainingPct = usedPct != null ? remainingPercent(usedPct) : null;
  const colors = usedPct != null ? meterFillColor(usedPct) : {
    bg: "bg-primary",
    text: "text-foreground",
    badge: "bg-muted text-muted-foreground",
  };

  // Determine label value
  let valueText = "";
  if (hasLimit && meter.remaining != null) {
    if (meter.unit === "USD") {
      valueText = `$${meter.remaining.toFixed(2)} / $${meter.limit!.toFixed(2)}`;
    } else {
      valueText = `${meter.remaining.toLocaleString()} / ${meter.limit!.toLocaleString()}`;
    }
  } else if (meter.used != null) {
    if (meter.unit === "USD") {
      valueText = `$${meter.used.toFixed(3)} used`;
    } else {
      valueText = `${meter.used.toLocaleString()} ${meter.unit ?? "used"}`;
    }
  } else if (remainingPct != null) {
    valueText = `${Math.round(remainingPct)}% left`;
  }

  const resetLabel = meter.resetsAt ? formatResetCountdown(meter.resetsAt) : null;

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-baseline justify-between gap-1.5 text-[11px] leading-tight">
        <span className="truncate font-medium text-foreground/90">
          {meter.label}
        </span>
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
          {valueText}
        </span>
      </div>

      {remainingPct != null ? (
        <div
          className="h-1 w-full overflow-hidden rounded-full bg-muted/60"
          role="progressbar"
          aria-valuenow={Math.round(remainingPct)}
          aria-valuemin={0}
          aria-valuemax={100}
          title={`${meter.label}: ${Math.round(usedPct!)}% used (${Math.round(remainingPct)}% left)`}
        >
          <div
            className={`h-full rounded-full transition-all duration-300 ease-out ${colors.bg}`}
            style={{ width: `${remainingPct}%` }}
          />
        </div>
      ) : null}

      {!compact && resetLabel && resetLabel !== "—" ? (
        <div className="flex items-center justify-between text-[10px] leading-none text-muted-foreground">
          <span>Resets in {resetLabel}</span>
          {usedPct != null ? (
            <span className={usedPct >= 80 ? colors.text : ""}>
              {Math.round(usedPct)}% used
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
