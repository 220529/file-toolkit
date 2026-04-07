import type { InputHTMLAttributes } from "react";
import { cn } from "../../utils/cn";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none transition-all",
        "placeholder:text-slate-400 focus:border-[var(--brand-400)] focus:ring-4 focus:ring-[var(--brand-100)]",
        className
      )}
      {...props}
    />
  );
}
