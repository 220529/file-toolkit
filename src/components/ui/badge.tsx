import type { HTMLAttributes, PropsWithChildren } from "react";
import { cn } from "../../utils/cn";

type BadgeTone = "default" | "info" | "success" | "warning" | "danger";

const toneClasses: Record<BadgeTone, string> = {
  default: "bg-slate-50 text-slate-700 ring-1 ring-slate-200",
  info: "bg-blue-50 text-blue-700 ring-1 ring-blue-200/70",
  success: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200/70",
  warning: "bg-amber-50 text-amber-700 ring-1 ring-amber-200/70",
  danger: "bg-rose-50 text-rose-700 ring-1 ring-rose-200/70",
};

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

export function Badge({ className, tone = "default", children, ...props }: PropsWithChildren<BadgeProps>) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-[6px] px-2 py-0.5 text-[11px] font-semibold",
        toneClasses[tone],
        className
      )}
      {...props}
    >
      {children}
    </span>
  );
}
