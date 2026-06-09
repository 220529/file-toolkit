import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type { ComponentPropsWithoutRef, ReactElement, ReactNode } from "react";
import { cn } from "../../utils/cn";

export const TooltipProvider = TooltipPrimitive.Provider;

interface TooltipProps extends Omit<ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>, "content"> {
  children: ReactElement;
  content: ReactNode;
  delayDuration?: number;
}

export function Tooltip({
  children,
  content,
  delayDuration = 300,
  side = "top",
  sideOffset = 8,
  className,
  ...props
}: TooltipProps) {
  return (
    <TooltipPrimitive.Root delayDuration={delayDuration}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={sideOffset}
          className={cn(
            "z-50 rounded-[6px] border border-slate-800 bg-slate-950 px-2.5 py-1.5 text-xs font-medium text-white shadow-[0_8px_20px_rgba(15,23,42,0.16)]",
            className
          )}
          {...props}
        >
          {content}
          <TooltipPrimitive.Arrow className="fill-slate-950" />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
