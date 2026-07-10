import * as DialogPrimitive from "@radix-ui/react-dialog";
import type { ComponentPropsWithoutRef, PropsWithChildren } from "react";
import { cn } from "../../utils/cn";

interface ModalProps extends ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  open?: boolean;
  onClose?: () => void;
  accessibleTitle: string;
}

export function Modal({ open = true, onClose, accessibleTitle, className, children, ...props }: PropsWithChildren<ModalProps>) {
  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose?.();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-[#101417]/42 backdrop-blur-sm data-[state=closed]:animate-none" />
        <DialogPrimitive.Content
          className={cn(
            "fixed left-1/2 top-1/2 z-50 w-[calc(100vw-32px)] max-w-3xl -translate-x-1/2 -translate-y-1/2 rounded-[8px] border border-[var(--stroke)] bg-white shadow-[0_18px_48px_rgba(16,20,23,0.16)] outline-none",
            "focus-visible:ring-2 focus-visible:ring-[var(--brand-300)] focus-visible:ring-offset-2 focus-visible:ring-offset-white",
            className
          )}
          {...props}
        >
          <DialogPrimitive.Title className="sr-only">{accessibleTitle}</DialogPrimitive.Title>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
