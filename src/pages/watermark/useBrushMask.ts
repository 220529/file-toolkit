import { useCallback, useEffect, useState } from "react";
import type { BrushStroke } from "../../api/tauri";
import type { RemoveMode } from "./types";
import { flattenBrushGestures, splitBrushGestures } from "./utils";

interface UseBrushMaskOptions {
  active: boolean;
  simpleMode: boolean;
  removeMode: RemoveMode;
  processing: boolean;
}

export function useBrushMask({ active, simpleMode, removeMode, processing }: UseBrushMaskOptions) {
  const [brushSize, setBrushSize] = useState(30);
  const [brushStrokes, setBrushStrokes] = useState<BrushStroke[]>([]);
  const [redoBrushGestures, setRedoBrushGestures] = useState<BrushStroke[][]>([]);

  const activeBrushStrokes = simpleMode ? [] : brushStrokes;
  const rawBrushGestureCount = splitBrushGestures(brushStrokes).length;
  const hasMaskEdits = !simpleMode && brushStrokes.length > 0;
  const brushGestureCount = simpleMode ? 0 : rawBrushGestureCount;
  const canRedoBrushStroke = !simpleMode && redoBrushGestures.length > 0;

  const clearBrushStrokes = useCallback(() => {
    setBrushStrokes([]);
  }, []);

  const clearBrushMask = useCallback(() => {
    setBrushStrokes([]);
    setRedoBrushGestures([]);
  }, []);

  const addBrushStroke = useCallback(
    (ox: number, oy: number, erase: boolean, start: boolean) => {
      if (start && redoBrushGestures.length > 0) {
        setRedoBrushGestures([]);
      }

      setBrushStrokes((prev) => {
        const nextStroke = {
          x: Number(ox.toFixed(2)),
          y: Number(oy.toFixed(2)),
          size: brushSize,
          erase,
          start,
        };
        const last = prev[prev.length - 1];
        if (
          !start &&
          last &&
          last.erase === nextStroke.erase &&
          last.size === nextStroke.size &&
          Math.hypot(last.x - nextStroke.x, last.y - nextStroke.y) < Math.max(1.5, brushSize * 0.18)
        ) {
          return prev;
        }
        return [...prev, nextStroke];
      });
    },
    [brushSize, redoBrushGestures.length]
  );

  const handleUndoBrushStroke = useCallback(() => {
    if (processing) return;

    const gestures = splitBrushGestures(brushStrokes);
    if (!gestures.length) return;

    const nextGestures = gestures.slice(0, -1);
    const undoneGesture = gestures[gestures.length - 1];
    setBrushStrokes(flattenBrushGestures(nextGestures));
    setRedoBrushGestures((prev) => [undoneGesture, ...prev]);
  }, [brushStrokes, processing]);

  const handleRedoBrushStroke = useCallback(() => {
    if (processing) return;
    if (!redoBrushGestures.length) return;

    const [gesture, ...remaining] = redoBrushGestures;
    setBrushStrokes((prev) => prev.concat(gesture));
    setRedoBrushGestures(remaining);
  }, [processing, redoBrushGestures]);

  useEffect(() => {
    if (processing || !active || simpleMode || removeMode !== "repair" || (!brushStrokes.length && !redoBrushGestures.length)) return;

    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target;
      const isEditable =
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);

      if (isEditable) return;

      if (event.metaKey || event.ctrlKey) {
        const key = event.key.toLowerCase();

        if (key === "z") {
          event.preventDefault();
          if (event.shiftKey) {
            handleRedoBrushStroke();
          } else {
            handleUndoBrushStroke();
          }
          return;
        }

        if (key === "y") {
          event.preventDefault();
          handleRedoBrushStroke();
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [
    active,
    brushStrokes.length,
    handleRedoBrushStroke,
    handleUndoBrushStroke,
    processing,
    redoBrushGestures.length,
    removeMode,
    simpleMode,
  ]);

  return {
    brushSize,
    setBrushSize,
    activeBrushStrokes,
    hasMaskEdits,
    brushGestureCount,
    canRedoBrushStroke,
    addBrushStroke,
    handleUndoBrushStroke,
    handleRedoBrushStroke,
    clearBrushStrokes,
    clearBrushMask,
  };
}
