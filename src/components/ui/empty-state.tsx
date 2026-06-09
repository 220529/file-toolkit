import type { HTMLAttributes, PropsWithChildren, ReactNode } from "react";
import { Icon } from "./icon";
import { cn } from "../../utils/cn";

interface EmptyStateProps extends HTMLAttributes<HTMLDivElement> {
  icon?: ReactNode;
  title: string;
  description?: string;
}

export function EmptyState({
  icon = <Icon name="info" size={26} />,
  title,
  description,
  className,
  children,
  ...props
}: PropsWithChildren<EmptyStateProps>) {
  return (
    <div
      className={cn(
        "flex min-h-[220px] flex-col items-center justify-center rounded-[10px] border border-dashed border-slate-300 bg-white px-6 py-10 text-center",
        className
      )}
      {...props}
    >
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-[8px] border border-slate-200 bg-slate-50 text-[var(--brand-700)]">
        {icon}
      </div>
      <div className="text-base font-semibold text-slate-900">{title}</div>
      {description && <div className="mt-2 max-w-md text-sm leading-6 text-slate-500">{description}</div>}
      {children}
    </div>
  );
}
