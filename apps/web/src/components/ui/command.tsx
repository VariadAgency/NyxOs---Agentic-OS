// Schlanker shadcn/ui-Baustein um cmdk: nur die Teile, die die Befehlspalette braucht.
import { Command as CommandPrimitive } from "cmdk";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../lib/cn";

export function CommandDialog(props: ComponentProps<typeof CommandPrimitive.Dialog>) {
  return (
    <CommandPrimitive.Dialog
      overlayClassName="fixed inset-0 z-50 cc-scrim"
      contentClassName="cc-palette fixed left-1/2 top-[18%] z-50 w-[92vw] max-w-[560px] -translate-x-1/2 overflow-hidden rounded-xl border border-a-line bg-a-p shadow-2xl"
      {...props}
    />
  );
}

export function CommandInputField({ after, icon, ...props }: ComponentProps<typeof CommandPrimitive.Input> & { after?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 border-b border-a-line px-3.5 py-2.5">
      <span aria-hidden="true" className="grid shrink-0 place-items-center text-a-mut">
        {icon ?? "⌕"}
      </span>
      <CommandPrimitive.Input
        className="w-full bg-transparent py-1 text-callout text-a-ink outline-none placeholder:text-a-mut"
        {...props}
      />
      {after}
    </div>
  );
}

export function CommandListBox(props: ComponentProps<typeof CommandPrimitive.List>) {
  return <CommandPrimitive.List className="cc-scroll max-h-[360px] overflow-y-auto p-1.5" {...props} />;
}

export function CommandGroupBox(props: ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      className="px-1.5 py-1 text-label font-medium uppercase tracking-wide text-a-mut [&_[cmdk-group-heading]]:px-1.5 [&_[cmdk-group-heading]]:py-1"
      {...props}
    />
  );
}

export function CommandItemRow({ className, ...props }: ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      className={cn(
        "flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-callout normal-case tracking-normal text-a-ink data-[selected=true]:bg-a-p3 data-[disabled=true]:cursor-default data-[disabled=true]:opacity-40",
        className,
      )}
      {...props}
    />
  );
}

export function CommandEmptyBox(props: ComponentProps<typeof CommandPrimitive.Empty>) {
  return <CommandPrimitive.Empty className="px-3.5 py-6 text-center text-caption text-a-mut" {...props} />;
}
