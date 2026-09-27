export function formatResetCountdown(
  resetsAt: number | null | undefined,
  now = Date.now(),
): string {
  if (resetsAt == null) return "—";
  const delta = resetsAt - now;
  if (delta <= 0) return "resetting";

  const totalSec = Math.round(delta / 1000);
  const days = Math.floor(totalSec / 86_400);
  const hours = Math.floor((totalSec % 86_400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${Math.max(minutes, 1)}m`;
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

export function remainingPercent(usedPercent: number): number {
  return clampPercent(100 - usedPercent);
}

export function meterFillColor(usedPercent: number): {
  bg: string;
  text: string;
  badge: string;
} {
  if (usedPercent >= 90) {
    return {
      bg: "bg-rose-500",
      text: "text-rose-500",
      badge: "bg-rose-500/10 text-rose-500 border-rose-500/20",
    };
  }
  if (usedPercent >= 75) {
    return {
      bg: "bg-amber-500",
      text: "text-amber-500",
      badge: "bg-amber-500/10 text-amber-500 border-amber-500/20",
    };
  }
  return {
    bg: "bg-emerald-500",
    text: "text-emerald-500",
    badge: "bg-emerald-500/10 text-emerald-500 border-emerald-500/20",
  };
}

export function formatRelativeTime(timestamp: number, now = Date.now()): string {
  const diffSec = Math.round((now - timestamp) / 1000);
  if (diffSec < 10) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
}
