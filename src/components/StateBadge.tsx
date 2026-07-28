import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Programme state marker. Ordinary states are hairline-outline rectangles;
 * only "current" fills signal red as a rounded on-air light.
 */
export function StateBadge({ current = false, className, children }: { current?: boolean; className?: string; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex w-fit items-center px-1.5 py-0.5 text-[0.65rem] font-bold tracking-[0.06em] uppercase",
        current
          ? "rounded-full bg-signal px-2 text-signal-foreground"
          : "rounded-[3px] border text-muted-foreground",
        className
      )}
    >
      {children}
    </span>
  );
}
