import { cn } from "../../utils/cn";

interface ProgressProps {
  value?: number;
  indeterminate?: boolean;
  className?: string;
  barClassName?: string;
}

export function Progress({ value = 0, indeterminate = false, className, barClassName }: ProgressProps) {
  return (
    <div className={cn("h-2 overflow-hidden rounded-full bg-[#e3e8e8]", className)}>
      {indeterminate ? (
        <div className={cn("h-full w-full animate-pulse bg-[var(--brand-500)]", barClassName)} />
      ) : (
        <div
          className={cn("h-full rounded-full bg-[var(--brand-500)] transition-all duration-300", barClassName)}
          style={{ width: `${Math.max(0, Math.min(value, 100))}%` }}
        />
      )}
    </div>
  );
}
