import type { ComponentProps } from "react";
import { cn } from "../../lib/cn";

type Variant = "default" | "primary" | "ghost" | "warn";

const base =
  // Apple-artig – gefüllte Flächen statt harter Rahmen, Radius 8 px, weiche Übergänge, leichtes Eindrücken.
  // `cc-hit` = at least 44 px hit area on touch devices (app.css); the visible size stays.
  "cc-hit inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md border text-caption font-medium px-2.5 py-1.5 transition-[background-color,border-color,color,filter,transform] duration-150 ease-apple motion-safe:active:scale-[.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-a-acc disabled:opacity-40 disabled:pointer-events-none";

const variants: Record<Variant, string> = {
  default: "border-a-line bg-a-p3 text-a-ink hover:border-a-line-strong hover:bg-[color-mix(in_srgb,var(--a-p3)_85%,white_6%)]",
  primary: "border-transparent bg-a-primary text-a-on-primary font-semibold hover:bg-white",
  ghost: "border-transparent bg-transparent text-a-mut hover:text-a-ink hover:bg-a-p2",
  warn: "border-a-wait/35 bg-a-wait/8 text-a-wait hover:bg-a-wait/14",
};

export function Button({ className, variant = "default", type = "button", ...props }: ComponentProps<"button"> & { variant?: Variant }) {
  // „warn“-Knöpfe (Schließen, Beenden …) sind riskant – Nyx zeigt nur darauf, klickt nie.
  return <button type={type} className={cn(base, variants[variant], className)} data-nyx-risk={variant === "warn" ? "" : undefined} {...props} />;
}
