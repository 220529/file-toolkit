import type { HTMLAttributes, PropsWithChildren } from "react";
import { cn } from "../../utils/cn";

type BadgeTone = "default" | "info" | "success" | "warning" | "danger";

const toneClasses: Record<BadgeTone, string> = {
  default: "bg-slate-100 text-slate-700",
  info: "bg-blue-50 text-blue-700 ring-1 ring-blue-100",
  success: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100",
  warning: "bg-amber-50 text-amber-700 ring-1 ring-amber-100",
  danger: "bg-rose-50 text-rose-700 ring-1 ring-rose-100",
};

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

export function Badge({ className, tone = "default", children, ...props }: PropsWithChildren<BadgeProps>) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-medium tracking-[0.02em]",
        toneClasses[tone],
        className
      )}
      {...props}
    >
      {children}
    </span>
  );
}
