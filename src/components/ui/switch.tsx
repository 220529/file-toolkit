import * as SwitchPrimitive from "@radix-ui/react-switch";
import type { ComponentPropsWithoutRef } from "react";
import { cn } from "../../utils/cn";

type SwitchProps = ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>;

export function Switch({ className, ...props }: SwitchProps) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition outline-none",
        "focus-visible:ring-2 focus-visible:ring-[var(--brand-300)] focus-visible:ring-offset-2 focus-visible:ring-offset-white",
        "data-[state=checked]:border-[var(--brand-500)] data-[state=checked]:bg-[var(--brand-500)]",
        "data-[state=unchecked]:border-slate-200 data-[state=unchecked]:bg-slate-200",
        "disabled:cursor-not-allowed disabled:opacity-50 disabled:saturate-50",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          "pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-[0_1px_4px_rgba(15,23,42,0.18)] transition-transform",
          "data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0.5"
        )}
      />
    </SwitchPrimitive.Root>
  );
}
