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
    "bg-[var(--brand-600)] text-white shadow-[0_10px_30px_rgba(43,104,241,0.24)] hover:bg-[var(--brand-500)]",
  secondary:
    "bg-white text-slate-900 ring-1 ring-slate-200 hover:bg-slate-50 hover:ring-slate-300",
  ghost:
    "bg-transparent text-slate-600 hover:bg-white hover:text-slate-900",
  danger:
    "bg-[var(--danger-600)] text-white shadow-[0_10px_24px_rgba(220,38,38,0.18)] hover:bg-[var(--danger-500)]",
  subtle:
    "bg-slate-100 text-slate-700 hover:bg-slate-200",
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
        "inline-flex items-center justify-center gap-2 rounded-xl font-medium transition-all duration-200 outline-none disabled:pointer-events-none disabled:opacity-45",
        "focus-visible:ring-2 focus-visible:ring-[var(--brand-300)] focus-visible:ring-offset-2 focus-visible:ring-offset-white",
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
