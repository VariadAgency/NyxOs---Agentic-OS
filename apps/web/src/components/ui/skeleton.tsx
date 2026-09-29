import type { ComponentProps } from "react";
import { cn } from "../../lib/cn";

/** Lade-Skelett, Farbton aus den Tokens statt grauem Standardgrau. */
export function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("animate-pulse rounded-md bg-a-p2", className)} {...props} />;
}
