import type { InputHTMLAttributes } from "react";
import { cn } from "../../utils/cn";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "h-10 w-full rounded-[8px] border border-[var(--stroke-strong)] bg-white px-3 text-sm text-[var(--text-strong)] outline-none transition-all",
        "placeholder:text-[var(--text-soft)] focus:border-[var(--brand-400)] focus:ring-[3px] focus:ring-[rgba(47,125,189,0.12)]",
        "disabled:cursor-not-allowed disabled:border-[var(--stroke)] disabled:bg-[#f1f3f1] disabled:text-[var(--text-soft)] disabled:shadow-none",
        className
      )}
      {...props}
    />
  );
}
