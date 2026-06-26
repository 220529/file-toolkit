import { useEffect, type RefObject } from "react";
import type { VideoInfo } from "../../api/tauri";
import { isEditableTarget } from "./utils";

interface UseVideoCutKeyboardShortcutsOptions {
  active: boolean;
  videoInfo: VideoInfo | null;
  processing: boolean;
  preciseMode: boolean;
  previewStrategy: "video" | "image";
  previewReady: boolean;
  previewVideoRef: RefObject<HTMLVideoElement | null>;
  startTimeRef: RefObject<number>;
  endTimeRef: RefObject<number>;
  onCancelCut: () => void | Promise<void>;
  onToggleClipPlayback: () => void | Promise<void>;
  onMovePreviewBySeconds: (seconds: number) => void;
  onStepPreviewFrame: (direction: -1 | 1) => void;
  onMovePreviewByFrames: (frameCount: number) => void;
  onShiftClipRangeBySeconds: (seconds: number) => void;
  onShiftClipRange: (direction: -1 | 1) => void;
  onApplyCurrentFrameToStart: () => void;
  onApplyCurrentFrameToEnd: () => void;
  onSyncPreviewTime: (time: number) => void;
  onPreviewClipMiddle: () => void;
  onSnapPreviewIntoClip: () => void;
  onToggleLoopClipPlayback: () => void;
}

export function useVideoCutKeyboardShortcuts({
  active,
  videoInfo,
  processing,
  preciseMode,
  previewStrategy,
  previewReady,
  previewVideoRef,
  startTimeRef,
  endTimeRef,
  onCancelCut,
  onToggleClipPlayback,
  onMovePreviewBySeconds,
  onStepPreviewFrame,
  onMovePreviewByFrames,
  onShiftClipRangeBySeconds,
  onShiftClipRange,
  onApplyCurrentFrameToStart,
  onApplyCurrentFrameToEnd,
  onSyncPreviewTime,
  onPreviewClipMiddle,
  onSnapPreviewIntoClip,
  onToggleLoopClipPlayback,
}: UseVideoCutKeyboardShortcutsOptions) {
  useEffect(() => {
    if (!active || !videoInfo) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (processing) {
        if (preciseMode && event.key === "Escape") {
          event.preventDefault();
          void onCancelCut();
        }
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isEditableTarget(event.target)) return;

      if (event.key === " ") {
        if (previewStrategy !== "video" || !previewReady) return;
        event.preventDefault();
        void onToggleClipPlayback();
        return;
      }

      if (event.key === "ArrowLeft") {
        event.preventDefault();
        if (event.shiftKey) {
          onMovePreviewBySeconds(-1);
        } else {
          onStepPreviewFrame(-1);
        }
        return;
      }

      if (event.key === "ArrowRight") {
        event.preventDefault();
        if (event.shiftKey) {
          onMovePreviewBySeconds(1);
        } else {
          onStepPreviewFrame(1);
        }
        return;
      }

      if (event.key === "PageUp") {
        event.preventDefault();
        onMovePreviewByFrames(-10);
        return;
      }

      if (event.key === "PageDown") {
        event.preventDefault();
        onMovePreviewByFrames(10);
        return;
      }

      if (event.key === "," || event.key === "<") {
        event.preventDefault();
        if (event.shiftKey) {
          onShiftClipRangeBySeconds(-1);
        } else {
          onShiftClipRange(-1);
        }
        return;
      }

      if (event.key === "." || event.key === ">") {
        event.preventDefault();
        if (event.shiftKey) {
          onShiftClipRangeBySeconds(1);
        } else {
          onShiftClipRange(1);
        }
        return;
      }

      if (event.key === "[") {
        event.preventDefault();
        onApplyCurrentFrameToStart();
        return;
      }

      if (event.key === "]") {
        event.preventDefault();
        onApplyCurrentFrameToEnd();
        return;
      }

      if (event.key.toLowerCase() === "i") {
        event.preventDefault();
        onApplyCurrentFrameToStart();
        return;
      }

      if (event.key.toLowerCase() === "o") {
        event.preventDefault();
        onApplyCurrentFrameToEnd();
        return;
      }

      if (event.key === "Home") {
        event.preventDefault();
        onSyncPreviewTime(startTimeRef.current);
        return;
      }

      if (event.key === "End") {
        event.preventDefault();
        onSyncPreviewTime(endTimeRef.current);
        return;
      }

      if (event.key.toLowerCase() === "m") {
        event.preventDefault();
        onPreviewClipMiddle();
        return;
      }

      if (event.key.toLowerCase() === "b") {
        event.preventDefault();
        onSnapPreviewIntoClip();
        return;
      }

      if (event.key.toLowerCase() === "r" && previewStrategy === "video" && previewReady) {
        event.preventDefault();
        onToggleLoopClipPlayback();
        return;
      }

      if (event.key.toLowerCase() === "j") {
        event.preventDefault();
        onMovePreviewByFrames(-10);
        return;
      }

      if (event.key.toLowerCase() === "k" && previewStrategy === "video") {
        event.preventDefault();
        const video = previewVideoRef.current;
        if (video && !video.paused) {
          video.pause();
        }
        return;
      }

      if (event.key.toLowerCase() === "l" && previewStrategy === "video" && previewReady) {
        event.preventDefault();
        void onToggleClipPlayback();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [
    active,
    endTimeRef,
    onApplyCurrentFrameToEnd,
    onApplyCurrentFrameToStart,
    onCancelCut,
    onMovePreviewByFrames,
    onMovePreviewBySeconds,
    onPreviewClipMiddle,
    onShiftClipRange,
    onShiftClipRangeBySeconds,
    onSnapPreviewIntoClip,
    onStepPreviewFrame,
    onSyncPreviewTime,
    onToggleClipPlayback,
    onToggleLoopClipPlayback,
    preciseMode,
    previewReady,
    previewStrategy,
    previewVideoRef,
    processing,
    startTimeRef,
    videoInfo,
  ]);
}
