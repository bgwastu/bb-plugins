import * as React from "react";

import { cn } from "../../lib/utils";

export interface SwitchProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "role" | "title"> {
  checked: boolean;
  onCheckedChange(checked: boolean): void;
  title?: string;
}

/** A small on/off toggle. A button with `role="switch"`, so it is keyboard- and screen-reader-operable. */
export function Switch({ checked, onCheckedChange, className, ...rest }: SwitchProps): React.ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => { onCheckedChange(!checked); }}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
        checked ? "bg-emerald-500" : "bg-muted-foreground/30",
        className,
      )}
      {...rest}
    >
      <span
        className={cn(
          "pointer-events-none inline-block size-4 rounded-full bg-white shadow-xs transition-transform",
          checked ? "translate-x-4" : "translate-x-0",
        )}
      />
    </button>
  );
}
