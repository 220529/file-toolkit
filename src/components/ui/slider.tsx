import * as SliderPrimitive from "@radix-ui/react-slider";
import type { ComponentPropsWithoutRef } from "react";
import { cn } from "../../utils/cn";

interface SliderProps extends Omit<ComponentPropsWithoutRef<typeof SliderPrimitive.Root>, "value" | "onValueChange"> {
  value: number;
  onValueChange?: (value: number) => void;
}

export function Slider({ className, value, onValueChange, min = 0, max = 100, step = 1, ...props }: SliderProps) {
  return (
    <SliderPrimitive.Root
      className={cn("relative flex h-5 w-full touch-none select-none items-center", className)}
      min={min}
      max={max}
      step={step}
      value={[value]}
      onValueChange={(nextValue) => {
        onValueChange?.(nextValue[0] ?? value);
      }}
      {...props}
    >
      <SliderPrimitive.Track className="relative h-2 grow overflow-hidden rounded-full bg-slate-200">
        <SliderPrimitive.Range className="absolute h-full rounded-full bg-[var(--brand-600)]" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        className={cn(
          "block h-4 w-4 rounded-full border border-[var(--brand-500)] bg-white shadow-[0_1px_3px_rgba(15,23,42,0.16)] outline-none transition",
          "focus-visible:ring-2 focus-visible:ring-[var(--brand-300)] focus-visible:ring-offset-2 focus-visible:ring-offset-white",
          "disabled:pointer-events-none disabled:opacity-50"
        )}
      />
    </SliderPrimitive.Root>
  );
}
