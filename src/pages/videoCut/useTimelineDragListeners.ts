import { useEffect } from "react";

type TimelineDragMode = "playhead" | "start" | "end";

interface UseTimelineDragListenersOptions {
  mode: TimelineDragMode | null;
  onDrag: (mode: TimelineDragMode, clientX: number) => void;
  onDragEnd: () => void;
}

export function useTimelineDragListeners({ mode, onDrag, onDragEnd }: UseTimelineDragListenersOptions) {
  useEffect(() => {
    if (!mode) return;

    const activeDragMode = mode;

    function handlePointerMove(event: PointerEvent) {
      onDrag(activeDragMode, event.clientX);
    }

    function handlePointerUp(event: PointerEvent) {
      onDrag(activeDragMode, event.clientX);
      onDragEnd();
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [mode, onDrag, onDragEnd]);
}
