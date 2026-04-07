import type { HTMLAttributes, PropsWithChildren } from "react";
import { cn } from "../../utils/cn";

export function SectionTitle({ className, children, ...props }: PropsWithChildren<HTMLAttributes<HTMLDivElement>>) {
  return (
    <div className={cn("flex items-center justify-between gap-4", className)} {...props}>
      {children}
    </div>
  );
}

export function SectionHeading({
  className,
  children,
  ...props
}: PropsWithChildren<HTMLAttributes<HTMLHeadingElement>>) {
  return (
    <h2 className={cn("text-xl font-semibold tracking-[-0.02em] text-slate-950", className)} {...props}>
      {children}
    </h2>
  );
}

export function SectionDescription({
  className,
  children,
  ...props
}: PropsWithChildren<HTMLAttributes<HTMLParagraphElement>>) {
  return (
    <p className={cn("text-sm leading-6 text-slate-500", className)} {...props}>
      {children}
    </p>
  );
}
