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
    "bg-[var(--brand-500)] text-white shadow-[0_8px_18px_rgba(47,125,189,0.18)] hover:bg-[var(--brand-600)] active:bg-[var(--brand-700)]",
  secondary:
    "bg-white text-[var(--text-strong)] ring-1 ring-[var(--stroke-strong)] hover:bg-[#f8faf8] hover:ring-[rgba(47,125,189,0.34)] active:bg-[#eef3f5]",
  ghost:
    "bg-transparent text-[var(--text-muted)] hover:bg-[#eef3f5] hover:text-[var(--text-strong)] active:bg-[#e4ebee]",
  danger:
    "bg-[var(--danger-600)] text-white shadow-[0_8px_18px_rgba(187,62,58,0.16)] hover:bg-[var(--danger-500)] active:bg-[#9f302d]",
  subtle:
    "bg-[#eef3f5] text-[var(--text-muted)] ring-1 ring-transparent hover:bg-white hover:text-[var(--text-strong)] hover:ring-[var(--stroke)] active:bg-[#e4ebee]",
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-xs",
  md: "h-10 px-4 text-sm",
  lg: "h-11 px-5 text-sm",
  icon: "h-9 w-9",
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
        "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[8px] font-medium transition-all duration-200 outline-none",
        "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-45 disabled:saturate-50 disabled:shadow-none disabled:ring-0",
        "focus-visible:ring-2 focus-visible:ring-[var(--brand-300)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--panel)]",
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
