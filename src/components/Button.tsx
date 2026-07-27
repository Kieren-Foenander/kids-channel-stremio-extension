import { Button as ShadcnButton } from "./ui/button";
import type { ComponentProps } from "react";

/**
 * Application button backed by shadcn/ui. The compatibility classes can be
 * removed as destinations move to explicit shadcn variants.
 */
export function Button({ className = "", variant: requestedVariant, ...props }: ComponentProps<typeof ShadcnButton>) {
  const variant = className.includes("button-secondary") ? "outline" : requestedVariant;
  return <ShadcnButton className={`button ${className}`.trim()} variant={variant} {...props} />;
}
