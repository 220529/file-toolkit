import type { ButtonHTMLAttributes, PropsWithChildren } from "react";
import { cn } from "../../utils/cn";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "subtle";
type ButtonSize = "sm" | "md" | "lg" | "icon";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    "bg-[var(--brand-600)] text-white hover:bg-[var(--brand-500)] active:bg-[var(--brand-700)]",
  secondary:
    "bg-white text-slate-900 ring-1 ring-slate-300 hover:bg-slate-50 hover:ring-slate-400 active:bg-slate-100",
  ghost:
    "bg-transparent text-slate-600 hover:bg-slate-100 hover:text-slate-950 active:bg-slate-200/70",
  danger:
    "bg-[var(--danger-600)] text-white hover:bg-[var(--danger-500)] active:bg-rose-700",
  subtle:
    "bg-slate-100 text-slate-700 ring-1 ring-slate-200 hover:bg-white hover:text-slate-950 active:bg-slate-100",
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-xs",
  md: "h-10 px-4 text-sm",
  lg: "h-11 px-5 text-sm",
  icon: "h-10 w-10",
};

export function Button({
  className,
  variant = "secondary",
  size = "md",
  children,
  ...props
}: PropsWithChildren<ButtonProps>) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-[8px] font-medium transition-all duration-200 outline-none",
        "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-45 disabled:saturate-50 disabled:shadow-none disabled:ring-0",
        "focus-visible:ring-2 focus-visible:ring-[var(--brand-300)] focus-visible:ring-offset-2 focus-visible:ring-offset-white",
        "active:translate-y-px",
        variantClasses[variant],
        sizeClasses[size],
        className
      )}
      {...props}
    >
      {children}
    </button>
  );
}
