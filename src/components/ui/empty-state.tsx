import type { HTMLAttributes, PropsWithChildren } from "react";
import { cn } from "../../utils/cn";

interface EmptyStateProps extends HTMLAttributes<HTMLDivElement> {
  icon?: string;
  title: string;
  description?: string;
}

export function EmptyState({
  icon = "◌",
  title,
  description,
  className,
  children,
  ...props
}: PropsWithChildren<EmptyStateProps>) {
  return (
    <div
      className={cn(
        "flex min-h-[220px] flex-col items-center justify-center rounded-[24px] border border-dashed border-slate-200 bg-slate-50/80 px-6 py-10 text-center",
        className
      )}
      {...props}
    >
      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-white text-2xl shadow-[0_12px_30px_rgba(15,23,42,0.08)]">
        {icon}
      </div>
      <div className="text-base font-semibold text-slate-900">{title}</div>
      {description && <div className="mt-2 max-w-md text-sm leading-6 text-slate-500">{description}</div>}
      {children}
    </div>
  );
}
