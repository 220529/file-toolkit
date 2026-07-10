import type { HTMLAttributes, PropsWithChildren } from "react";
import { cn } from "../../utils/cn";

type BadgeTone = "default" | "info" | "success" | "warning" | "danger";

const toneClasses: Record<BadgeTone, string> = {
  default: "bg-[#f1f3f1] text-[var(--text-muted)] ring-1 ring-[var(--stroke)]",
  info: "bg-[var(--brand-50)] text-[var(--brand-700)] ring-1 ring-[rgba(47,125,189,0.22)]",
  success: "bg-[#eaf7f2] text-[var(--success-600)] ring-1 ring-[rgba(24,116,86,0.18)]",
  warning: "bg-[#fff4df] text-[var(--warning-600)] ring-1 ring-[rgba(177,106,37,0.18)]",
  danger: "bg-[#fff0ef] text-[var(--danger-600)] ring-1 ring-[rgba(187,62,58,0.18)]",
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
