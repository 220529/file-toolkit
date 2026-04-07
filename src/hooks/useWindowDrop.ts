import { useEffect, useEffectEvent, useState } from "react";
import { safeListen } from "../utils/tauriEvent";

interface DragDropPayload {
  paths: string[];
}

interface UseWindowDropOptions {
  active?: boolean;
  onDrop: (paths: string[]) => void | Promise<void>;
}

export function useWindowDrop({ active = true, onDrop }: UseWindowDropOptions) {
  const [dragging, setDragging] = useState(false);
  const handleDrop = useEffectEvent(onDrop);

  useEffect(() => {
    if (!active) {
      setDragging(false);
      return;
    }

    const cleanupEnter = safeListen<DragDropPayload>("tauri://drag-enter", () => {
      setDragging(true);
    });
    const cleanupLeave = safeListen("tauri://drag-leave", () => {
      setDragging(false);
    });
    const cleanupDrop = safeListen<DragDropPayload>("tauri://drag-drop", (event) => {
      setDragging(false);
      const paths = event.payload.paths;
      if (paths && paths.length > 0) {
        void handleDrop(paths);
      }
    });

    return () => {
      cleanupEnter();
      cleanupLeave();
      cleanupDrop();
    };
  }, [active, handleDrop]);

  return { dragging };
}
