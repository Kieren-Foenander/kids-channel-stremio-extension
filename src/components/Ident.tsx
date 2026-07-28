import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * The channel bug: a signal-red block with expanded white caps, used like an
 * on-screen ident to label channels, programme types, and page context.
 */
export function Ident({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      data-slot="ident"
      className={cn(
        "inline-flex w-fit items-center rounded-[3px] bg-signal px-1.5 py-1 text-[0.65rem] leading-none font-extrabold tracking-[0.08em] text-signal-foreground uppercase [font-stretch:125%]",
        className
      )}
    >
      {children}
    </span>
  );
}
