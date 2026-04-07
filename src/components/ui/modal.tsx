import type { HTMLAttributes, PropsWithChildren } from "react";
import { cn } from "../../utils/cn";

interface ModalProps extends HTMLAttributes<HTMLDivElement> {
  open?: boolean;
  onClose?: () => void;
}

export function Modal({ open = true, onClose, className, children, ...props }: PropsWithChildren<ModalProps>) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/48 px-4 py-8" onClick={onClose}>
      <div
        className={cn(
          "w-full max-w-3xl rounded-[26px] border border-white/70 bg-white shadow-[0_40px_120px_rgba(15,23,42,0.18)]",
          className
        )}
        onClick={(event) => event.stopPropagation()}
        {...props}
      >
        {children}
      </div>
    </div>
  );
}
