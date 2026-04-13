import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type SyntheticEvent, type WheelEvent as ReactWheelEvent } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { dirname, normalize, resolve } from "@tauri-apps/api/path";
import { open, save } from "@tauri-apps/plugin-dialog";
import { exists, stat } from "@tauri-apps/plugin-fs";
import { useTaskReporter } from "../components/TaskCenter";
import { useToast } from "../components/Toast";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Progress } from "../components/ui/progress";
import { Switch } from "../components/ui/switch";
import { useWindowDrop } from "../hooks/useWindowDrop";
import { cn } from "../utils/cn";
import { safeListen } from "../utils/tauriEvent";
import { getBaseName, getExtension, stripExtension } from "../utils/path";

interface VideoInfo {
  duration: number;
  width: number;
  height: number;
  fps: number;
}

type TimelineDragMode = "playhead" | "start" | "end";
type PlaybackMode = "manual" | "clip";

const PRECISE_MODE_STORAGE_KEY = "video-cut-precise-mode";
const LOOP_PLAYBACK_STORAGE_KEY = "video-cut-loop-playback";
const LAST_OUTPUT_DIR_STORAGE_KEY = "video-cut-last-output-dir";
const ADVANCED_CONTROLS_STORAGE_KEY = "video-cut-advanced-controls";
const SUPPORTED_VIDEO_EXTENSIONS = ["mp4", "mov", "avi", "mkv", "wmv", "flv", "webm"];

function formatTime(seconds: number) {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(totalMs / 3_600_000);
  const m = Math.floor((totalMs % 3_600_000) / 60_000);
  const s = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}.${ms.toString().padStart(3, "0")}`;
  }
  return `${m}:${s.toString().padStart(2, "0")}.${ms.toString().padStart(3, "0")}`;
}

function formatTimeForFilename(seconds: number) {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(totalMs / 3_600_000);
  const m = Math.floor((totalMs % 3_600_000) / 60_000);
  const s = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  if (h > 0) {
    return `${h.toString().padStart(2, "0")}h${m.toString().padStart(2, "0")}m${s.toString().padStart(2, "0")}s${ms.toString().padStart(3, "0")}ms`;
  }
  return `${m.toString().padStart(2, "0")}m${s.toString().padStart(2, "0")}s${ms.toString().padStart(3, "0")}ms`;
}

function formatSignedOffsetLabel(seconds: number) {
  return seconds >= 0 ? `+${formatTime(seconds)}` : `-${formatTime(Math.abs(seconds))}`;
}

function parseTimeInput(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^\d+(?:\.\d+)?(?::\d+(?:\.\d+)?){0,2}$/.test(trimmed)) return null;

  const parts = trimmed.split(":").map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part) || part < 0)) return null;

  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0];
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function getMinClipDuration(duration: number, fps: number) {
  if (duration <= 0) return 0;
  return Math.min(getFrameDuration(fps), duration);
}

function getFrameDuration(fps: number) {
  if (!Number.isFinite(fps) || fps <= 0) return 1 / 30;
  const normalizedFps = clamp(fps, 1, 120);
  return 1 / normalizedFps;
}

function getFrameNumber(time: number, info: VideoInfo | null) {
  if (!info) return 0;
  const frameDuration = getFrameDuration(info.fps);
  return Math.max(1, Math.round(time / frameDuration) + 1);
}

function getClipFrameCount(start: number, end: number, info: VideoInfo | null) {
  if (!info) return 0;
  const frameDuration = getFrameDuration(info.fps);
  return Math.max(1, Math.round((end - start) / frameDuration));
}

function snapTimeToFrame(time: number, info: VideoInfo | null, strategy: "nearest" | "floor" | "ceil" = "nearest") {
  if (!info) return Math.max(0, time);
  const duration = Math.max(0, info.duration);
  if (duration <= 0) return 0;
  if (time <= 0) return 0;
  if (time >= duration) return duration;

  const frameDuration = getFrameDuration(info.fps);
  const frameIndex = time / frameDuration;
  const snappedIndex =
    strategy === "floor" ? Math.floor(frameIndex) : strategy === "ceil" ? Math.ceil(frameIndex) : Math.round(frameIndex);
  return clamp(snappedIndex * frameDuration, 0, duration);
}

function formatFps(fps: number) {
  if (!Number.isFinite(fps) || fps <= 0) return "30";
  return fps.toFixed(2).replace(/\.?0+$/, "");
}

function getTimelineFrameCount(duration: number, width: number) {
  const minCount =
    duration <= 30 ? 8 :
    duration <= 2 * 60 ? 10 :
    duration <= 10 * 60 ? 12 :
    duration <= 30 * 60 ? 14 :
    16;

  if (width <= 0) return minCount;

  const widthBasedCount = Math.round(width / 92);
  return clamp(widthBasedCount, minCount, 24);
}

function getPreferredPreviewStrategy(path: string): "video" | "image" {
  const ext = getExtension(path).toLowerCase();
  return ["mp4", "mov", "webm"].includes(ext) ? "video" : "image";
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function getPreferredPreciseOutputExtension(ext: string) {
  const normalizedExt = ext.toLowerCase();
  if (["mp4", "mov", "m4v", "mkv"].includes(normalizedExt)) {
    return normalizedExt;
  }
  return "mp4";
}

function isSupportedPreciseOutputExtension(ext: string) {
  return ["mp4", "mov", "m4v", "mkv"].includes(ext.toLowerCase());
}

function ensureOutputPathExtension(path: string, ext: string) {
  return getExtension(path) ? path : `${path}.${ext}`;
}

export default function VideoCut({ active = true }: { active?: boolean }) {
  const [videoPath, setVideoPath] = useState("");
  const [videoInfo, setVideoInfo] = useState<VideoInfo | null>(null);
  const [startTime, setStartTime] = useState(0);
  const [endTime, setEndTime] = useState(0);
  const [processing, setProcessing] = useState(false);
  const [preciseMode, setPreciseMode] = useState(false);
  const [previewStrategy, setPreviewStrategy] = useState<"video" | "image">("video");
  const [previewFrame, setPreviewFrame] = useState("");
  const [timelineFrames, setTimelineFrames] = useState<string[]>([]);
  const [currentPreviewTime, setCurrentPreviewTime] = useState(0);
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const [clipPlaybackActive, setClipPlaybackActive] = useState(false);
  const [loopClipPlayback, setLoopClipPlayback] = useState(false);
  const [showAdvancedControls, setShowAdvancedControls] = useState(false);
  const [previewFrameError, setPreviewFrameError] = useState(false);
  const [loadingTimelineFrames, setLoadingTimelineFrames] = useState(false);
  const [timelineFramesError, setTimelineFramesError] = useState(false);
  const [timelineWidth, setTimelineWidth] = useState(0);
  const [hoverTimelineTime, setHoverTimelineTime] = useState<number | null>(null);
  const [videoCacheKey, setVideoCacheKey] = useState("");
  const loadRequestIdRef = useRef(0);
  const previewRequestIdRef = useRef(0);
  const timelineRequestIdRef = useRef(0);
  const lastTimelineFrameCountRef = useRef(0);
  const timelineFramesCacheRef = useRef(new Map<string, string[]>());
  const previewFrameCacheRef = useRef(new Map<string, string>());
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  const previewSeekRafRef = useRef<number | null>(null);
  const pendingPreviewSeekRef = useRef<number | null>(null);
  const previewTimeoutRef = useRef<number | null>(null);
  const timelineLoadTimeoutRef = useRef<number | null>(null);
  const [timelineDragMode, setTimelineDragMode] = useState<TimelineDragMode | null>(null);
  const videoInfoRef = useRef<VideoInfo | null>(null);
  const videoPathRef = useRef("");
  const startTimeRef = useRef(0);
  const endTimeRef = useRef(0);
  const currentPreviewTimeRef = useRef(0);
  const playbackModeRef = useRef<PlaybackMode>("manual");
  const clipPlaybackActiveRef = useRef(false);
  const loopClipPlaybackRef = useRef(false);
  const [startTimeInput, setStartTimeInput] = useState("");
  const [endTimeInput, setEndTimeInput] = useState("");
  const [editingStart, setEditingStart] = useState(false);
  const [editingEnd, setEditingEnd] = useState(false);
  const [progress, setProgress] = useState(0);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [previewReady, setPreviewReady] = useState(false);
  const toast = useToast();
  const task = useTaskReporter("video-cut");
  const previewVideoSrc = videoPath ? convertFileSrc(videoPath) : "";
  videoInfoRef.current = videoInfo;
  videoPathRef.current = videoPath;
  startTimeRef.current = startTime;
  endTimeRef.current = endTime;
  currentPreviewTimeRef.current = currentPreviewTime;
  loopClipPlaybackRef.current = loopClipPlayback;
  const { dragging } = useWindowDrop({
    active,
    onDrop: (paths) => {
      if (processing) {
        toast.info("当前正在处理，暂时无法更换视频");
        return;
      }
      const file = paths[0];
      const ext = getExtension(file).toLowerCase();
      if (SUPPORTED_VIDEO_EXTENSIONS.includes(ext)) {
        void loadVideo(file);
      } else {
        toast.error("暂不支持该文件格式，请选择常见视频文件");
      }
    },
  });

  useEffect(() => {
    if (!active) return;

    return safeListen<number>("video-progress", (event) => {
      setProgress(event.payload);
    });
  }, [active]);

  useEffect(() => {
    try {
      const storedPreciseMode = window.localStorage.getItem(PRECISE_MODE_STORAGE_KEY);
      if (storedPreciseMode === "true" || storedPreciseMode === "false") {
        setPreciseMode(storedPreciseMode === "true");
      }

      const storedLoopPlayback = window.localStorage.getItem(LOOP_PLAYBACK_STORAGE_KEY);
      if (storedLoopPlayback === "true" || storedLoopPlayback === "false") {
        setLoopClipPlayback(storedLoopPlayback === "true");
      }

      const storedAdvancedControls = window.localStorage.getItem(ADVANCED_CONTROLS_STORAGE_KEY);
      if (storedAdvancedControls === "true" || storedAdvancedControls === "false") {
        setShowAdvancedControls(storedAdvancedControls === "true");
      }
    } catch (error) {
      console.error("读取视频截取偏好失败:", error);
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(PRECISE_MODE_STORAGE_KEY, preciseMode ? "true" : "false");
    } catch (error) {
      console.error("保存精确模式偏好失败:", error);
    }
  }, [preciseMode]);

  useEffect(() => {
    try {
      window.localStorage.setItem(LOOP_PLAYBACK_STORAGE_KEY, loopClipPlayback ? "true" : "false");
    } catch (error) {
      console.error("保存循环播放偏好失败:", error);
    }
  }, [loopClipPlayback]);

  useEffect(() => {
    try {
      window.localStorage.setItem(ADVANCED_CONTROLS_STORAGE_KEY, showAdvancedControls ? "true" : "false");
    } catch (error) {
      console.error("保存高级微调展开状态失败:", error);
    }
  }, [showAdvancedControls]);

  useEffect(() => {
    if (!processing) {
      task.clearTask();
      return;
    }

    const video = previewVideoRef.current;
    if (video && !video.paused) {
      video.pause();
    }
    setClipPlaybackState(false);

    task.reportTask({
      title: "视频截取",
      stage: preciseMode ? "精确模式处理中" : "快速截取处理中",
      detail: videoPath ? getBaseName(videoPath) : "等待文件",
      progress: preciseMode ? progress : undefined,
      cancellable: preciseMode,
      onCancel: preciseMode ? cancelCut : undefined,
    });
  }, [processing, preciseMode, progress, videoPath]);

  useEffect(() => {
    return () => {
      loadRequestIdRef.current += 1;
      previewRequestIdRef.current += 1;
      timelineRequestIdRef.current += 1;
      if (previewSeekRafRef.current !== null) {
        window.cancelAnimationFrame(previewSeekRafRef.current);
        previewSeekRafRef.current = null;
      }
      clearPendingPreviewTimeout();
      if (timelineLoadTimeoutRef.current !== null) {
        window.clearTimeout(timelineLoadTimeoutRef.current);
        timelineLoadTimeoutRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline) return;

    const updateWidth = (nextWidth: number) => {
      const roundedWidth = Math.max(0, Math.round(nextWidth));
      setTimelineWidth((current) => (current === roundedWidth ? current : roundedWidth));
    };

    updateWidth(timeline.getBoundingClientRect().width);

    if (typeof ResizeObserver === "undefined") {
      const observedTimeline = timeline;
      function handleResize() {
        updateWidth(observedTimeline.getBoundingClientRect().width);
      }

      window.addEventListener("resize", handleResize);
      return () => {
        window.removeEventListener("resize", handleResize);
      };
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      updateWidth(entry.contentRect.width);
    });

    observer.observe(timeline);
    return () => {
      observer.disconnect();
    };
  }, [videoPath, videoInfo]);

  useEffect(() => {
    if (!videoPath || !videoInfo) return;

    const count = getTimelineFrameCount(videoInfo.duration, timelineWidth);
    if (count === lastTimelineFrameCountRef.current && timelineFrames.length > 0) return;

    if (timelineLoadTimeoutRef.current !== null) {
      window.clearTimeout(timelineLoadTimeoutRef.current);
    }

    timelineLoadTimeoutRef.current = window.setTimeout(() => {
      timelineLoadTimeoutRef.current = null;
      lastTimelineFrameCountRef.current = count;
      void loadTimelineFrames(videoPath, count);
    }, 120);

    return () => {
      if (timelineLoadTimeoutRef.current !== null) {
        window.clearTimeout(timelineLoadTimeoutRef.current);
        timelineLoadTimeoutRef.current = null;
      }
    };
  }, [videoInfo, videoPath, timelineWidth]);

  useEffect(() => {
    if (!active || !videoInfo) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (processing) {
        if (preciseMode && event.key === "Escape") {
          event.preventDefault();
          void cancelCut();
        }
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isEditableTarget(event.target)) return;

      if (event.key === " ") {
        if (previewStrategy !== "video" || !previewReady) return;
        event.preventDefault();
        void toggleClipPlayback();
        return;
      }

      if (event.key === "ArrowLeft") {
        event.preventDefault();
        if (event.shiftKey) {
          movePreviewBySeconds(-1);
        } else {
          stepPreviewFrame(-1);
        }
        return;
      }

      if (event.key === "ArrowRight") {
        event.preventDefault();
        if (event.shiftKey) {
          movePreviewBySeconds(1);
        } else {
          stepPreviewFrame(1);
        }
        return;
      }

      if (event.key === "PageUp") {
        event.preventDefault();
        movePreviewByFrames(-10);
        return;
      }

      if (event.key === "PageDown") {
        event.preventDefault();
        movePreviewByFrames(10);
        return;
      }

      if (event.key === "," || event.key === "<") {
        event.preventDefault();
        if (event.shiftKey) {
          shiftClipRangeBySeconds(-1);
        } else {
          shiftClipRange(-1);
        }
        return;
      }

      if (event.key === "." || event.key === ">") {
        event.preventDefault();
        if (event.shiftKey) {
          shiftClipRangeBySeconds(1);
        } else {
          shiftClipRange(1);
        }
        return;
      }

      if (event.key === "[") {
        event.preventDefault();
        applyCurrentFrameToStart();
        return;
      }

      if (event.key === "]") {
        event.preventDefault();
        applyCurrentFrameToEnd();
        return;
      }

      if (event.key.toLowerCase() === "i") {
        event.preventDefault();
        applyCurrentFrameToStart();
        return;
      }

      if (event.key.toLowerCase() === "o") {
        event.preventDefault();
        applyCurrentFrameToEnd();
        return;
      }

      if (event.key === "Home") {
        event.preventDefault();
        syncPreviewTime(startTimeRef.current);
        return;
      }

      if (event.key === "End") {
        event.preventDefault();
        syncPreviewTime(endTimeRef.current);
        return;
      }

      if (event.key.toLowerCase() === "m") {
        event.preventDefault();
        previewClipMiddle();
        return;
      }

      if (event.key.toLowerCase() === "b") {
        event.preventDefault();
        snapPreviewIntoClip();
        return;
      }

      if (event.key.toLowerCase() === "r" && previewStrategy === "video" && previewReady) {
        event.preventDefault();
        setLoopClipPlayback((current) => !current);
        return;
      }

      if (event.key.toLowerCase() === "j") {
        event.preventDefault();
        movePreviewByFrames(-10);
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
        void toggleClipPlayback();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [active, previewReady, previewStrategy, videoInfo, processing, preciseMode]);

  useEffect(() => {
    if (!timelineDragMode) return;

    const activeDragMode = timelineDragMode;

    function handlePointerMove(event: PointerEvent) {
      updateTimelineDrag(activeDragMode, event.clientX);
    }

    function handlePointerUp(event: PointerEvent) {
      updateTimelineDrag(activeDragMode, event.clientX);
      setTimelineDragMode(null);
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [timelineDragMode]);

  function clearPendingPreviewTimeout() {
    if (previewTimeoutRef.current !== null) {
      window.clearTimeout(previewTimeoutRef.current);
      previewTimeoutRef.current = null;
    }
  }

  function schedulePreviewSeek(time: number) {
    pendingPreviewSeekRef.current = time;
    if (previewSeekRafRef.current !== null) return;

    previewSeekRafRef.current = window.requestAnimationFrame(() => {
      previewSeekRafRef.current = null;
      const nextTime = pendingPreviewSeekRef.current;
      const video = previewVideoRef.current;
      if (nextTime === null || !video || video.readyState < 1) return;
      if (!video.paused) {
        if (clipPlaybackActiveRef.current) {
          setClipPlaybackState(false);
        }
        video.pause();
      }
      if (Math.abs(video.currentTime - nextTime) > 0.001) {
        video.currentTime = nextTime;
      }
    });
  }

  function syncPreviewTime(time: number) {
    const info = videoInfoRef.current;
    const next = info ? clamp(time, 0, info.duration) : Math.max(0, time);
    setCurrentPreviewTime(next);
    if (previewStrategy === "video") {
      schedulePreviewSeek(next);
    } else {
      updatePreviewDebounced(next);
    }
  }

  function handlePreviewLoadedMetadata(event: SyntheticEvent<HTMLVideoElement>) {
    setPreviewReady(true);
    const next = pendingPreviewSeekRef.current ?? currentPreviewTime;
    if (next > 0) {
      event.currentTarget.currentTime = next;
    }
  }

  function handlePreviewTimeUpdate(event: SyntheticEvent<HTMLVideoElement>) {
    const video = event.currentTarget;
    const info = videoInfoRef.current;
    if (!info) return;

    const clipEnd = endTimeRef.current;
    const clipStart = startTimeRef.current;
    const frameDuration = getFrameDuration(info.fps);
    const clipEscaped =
      clipPlaybackActiveRef.current && (video.currentTime < clipStart - frameDuration / 2 || video.currentTime > clipEnd + frameDuration / 2);
    const clipReachedEnd = clipPlaybackActiveRef.current && clipEnd > clipStart && video.currentTime >= clipEnd - frameDuration / 2;

    if (clipEscaped && !clipReachedEnd) {
      setClipPlaybackState(false);
    }

    if (clipReachedEnd) {
      if (loopClipPlaybackRef.current) {
        video.currentTime = clipStart;
        setCurrentPreviewTime(clipStart);
        void video.play().catch(() => {
          setClipPlaybackState(false);
        });
        return;
      }

      setClipPlaybackState(false);
      if (!video.paused) {
        video.pause();
      }
      video.currentTime = clipEnd;
      setCurrentPreviewTime(clipEnd);
      return;
    }

    const next = snapTimeToFrame(video.currentTime, info);
    setCurrentPreviewTime(next);
  }

  function handlePreviewPlay() {
    setPreviewPlaying(true);
  }

  function handlePreviewPause() {
    setPreviewPlaying(false);
    if (playbackModeRef.current === "clip") {
      setClipPlaybackState(false);
    }
  }

  function handlePreviewError() {
    const path = videoPathRef.current;
    if (!path) return;
    setPreviewReady(false);
    setPreviewStrategy("image");
    setClipPlaybackState(false);
    toast.info("当前格式不支持连续视频预览，已切换为静态预览。");
    if (previewSeekRafRef.current !== null) {
      window.cancelAnimationFrame(previewSeekRafRef.current);
      previewSeekRafRef.current = null;
    }
    void loadPreviewFrame(path, currentPreviewTime);
  }

  function getTimelineTimeFromClientX(clientX: number) {
    const info = videoInfoRef.current;
    const timeline = timelineRef.current;
    if (!info || !timeline) return 0;

    const rect = timeline.getBoundingClientRect();
    if (rect.width <= 0) return 0;

    const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
    return ratio * info.duration;
  }

  function setClipPlaybackState(active: boolean) {
    clipPlaybackActiveRef.current = active;
    setClipPlaybackActive(active);
    if (!active) {
      playbackModeRef.current = "manual";
    }
  }

  function commitRange(nextStart: number, nextEnd: number) {
    startTimeRef.current = nextStart;
    endTimeRef.current = nextEnd;
    setStartTime(nextStart);
    setEndTime(nextEnd);
  }

  function resolveRangeFromStart(time: number, behavior: "clamp" | "shift-end") {
    const info = videoInfoRef.current;
    if (!info) return null;

    const minDuration = getMinClipDuration(info.duration, info.fps);
    let nextStart = clamp(snapTimeToFrame(time, info, "floor"), 0, info.duration);
    let nextEnd = endTimeRef.current;

    if (behavior === "clamp") {
      nextStart = clamp(nextStart, 0, Math.max(0, nextEnd - minDuration));
    } else if (nextEnd - nextStart < minDuration) {
      nextEnd = clamp(nextStart + minDuration, 0, info.duration);
      if (nextEnd - nextStart < minDuration) {
        nextStart = Math.max(0, nextEnd - minDuration);
      }
    }

    return { start: nextStart, end: nextEnd };
  }

  function resolveRangeFromEnd(time: number, behavior: "clamp" | "shift-start") {
    const info = videoInfoRef.current;
    if (!info) return null;

    const minDuration = getMinClipDuration(info.duration, info.fps);
    let nextEnd = clamp(snapTimeToFrame(time, info, "ceil"), 0, info.duration);
    let nextStart = startTimeRef.current;

    if (behavior === "clamp") {
      nextEnd = clamp(nextEnd, Math.min(info.duration, nextStart + minDuration), info.duration);
    } else if (nextEnd - nextStart < minDuration) {
      nextStart = clamp(nextEnd - minDuration, 0, info.duration);
      if (nextEnd - nextStart < minDuration) {
        nextEnd = Math.min(info.duration, nextStart + minDuration);
      }
    }

    return { start: nextStart, end: nextEnd };
  }

  async function ensureVideoPathAvailable(path: string, actionLabel: string) {
    try {
      const available = await exists(path);
      if (!available) {
        toast.error(`${actionLabel}失败：视频文件不存在，可能已被移动或外接磁盘已断开`);
      }
      return available;
    } catch (error) {
      toast.error(`${actionLabel}失败：无法访问视频文件`);
      console.error(`${actionLabel}时检查文件失败:`, error);
      return false;
    }
  }

  async function buildVideoCacheKey(path: string) {
    try {
      const info = await stat(path);
      const mtime = info.mtime instanceof Date ? info.mtime.getTime() : 0;
      return `${path}::${info.size}::${mtime}`;
    } catch (error) {
      console.error("读取视频文件信息失败，回退为路径缓存键:", error);
      return path;
    }
  }

  async function isSameVideoPath(inputPath: string, outputPath: string) {
    try {
      const [normalizedInputPath, normalizedOutputPath] = await Promise.all([
        normalize(inputPath),
        normalize(outputPath),
      ]);
      return normalizedInputPath === normalizedOutputPath;
    } catch (error) {
      console.error("比对导出路径失败:", error);
      return inputPath === outputPath;
    }
  }

  function getStoredLastOutputDir() {
    try {
      return window.localStorage.getItem(LAST_OUTPUT_DIR_STORAGE_KEY) || "";
    } catch (error) {
      console.error("读取上次导出目录失败:", error);
      return "";
    }
  }

  async function buildDefaultOutputPath(fileName: string) {
    const lastOutputDir = getStoredLastOutputDir();
    if (!lastOutputDir) return fileName;

    try {
      const dirAvailable = await exists(lastOutputDir);
      if (!dirAvailable) return fileName;
      return await resolve(lastOutputDir, fileName);
    } catch (error) {
      console.error("拼接默认导出路径失败:", error);
      return fileName;
    }
  }

  async function rememberLastOutputDir(path: string) {
    try {
      const outputDir = await dirname(path);
      window.localStorage.setItem(LAST_OUTPUT_DIR_STORAGE_KEY, outputDir);
    } catch (error) {
      console.error("保存上次导出目录失败:", error);
    }
  }

  async function toggleClipPlayback() {
    if (processing) return;
    const video = previewVideoRef.current;
    if (!video || previewStrategy !== "video" || !previewReady) return;
    if (clipDuration <= 0) return;

    if (clipPlaybackActiveRef.current) {
      setClipPlaybackState(false);
      if (!video.paused) {
        video.pause();
      }
      return;
    }

    const clipStart = startTimeRef.current;
    const clipEnd = endTimeRef.current;
    if (video.currentTime < clipStart || video.currentTime >= clipEnd) {
      video.currentTime = clipStart;
      setCurrentPreviewTime(clipStart);
    }

    playbackModeRef.current = "clip";
    setClipPlaybackState(true);
    try {
      await video.play();
    } catch (error) {
      console.error("片段播放失败:", error);
      setClipPlaybackState(false);
    }
  }

  function updateTimelineDrag(mode: TimelineDragMode, clientX: number) {
    const info = videoInfoRef.current;
    if (!info) return;

    const rawTime = getTimelineTimeFromClientX(clientX);

    if (mode === "start") {
      const range = resolveRangeFromStart(rawTime, "clamp");
      if (!range) return;
      commitRange(range.start, range.end);
      syncPreviewTime(range.start);
      return;
    }

    if (mode === "end") {
      const range = resolveRangeFromEnd(rawTime, "clamp");
      if (!range) return;
      commitRange(range.start, range.end);
      syncPreviewTime(range.end);
      return;
    }

    const next = clamp(snapTimeToFrame(rawTime, info), 0, info.duration);
    syncPreviewTime(next);
  }

  function beginTimelineDrag(mode: TimelineDragMode, clientX: number) {
    setTimelineDragMode(mode);
    updateTimelineDrag(mode, clientX);
  }

  function applyCurrentFrameToStart() {
    const range = resolveRangeFromStart(currentPreviewTime, "shift-end");
    if (!range) return;
    commitRange(range.start, range.end);
    syncPreviewTime(range.start);
  }

  function applyCurrentFrameToEnd() {
    const range = resolveRangeFromEnd(currentPreviewTime, "shift-start");
    if (!range) return;
    commitRange(range.start, range.end);
    syncPreviewTime(range.end);
  }

  function stepPreviewFrame(direction: -1 | 1) {
    const info = videoInfoRef.current;
    if (!info) return;
    const frameDuration = getFrameDuration(info.fps);
    const strategy = direction < 0 ? "floor" : "ceil";
    const next = snapTimeToFrame(currentPreviewTimeRef.current + direction * frameDuration, info, strategy);
    syncPreviewTime(next);
  }

  function movePreviewBySeconds(seconds: number) {
    const info = videoInfoRef.current;
    if (!info) return;
    const next = snapTimeToFrame(currentPreviewTimeRef.current + seconds, info);
    syncPreviewTime(next);
  }

  function movePreviewByFrames(frameCount: number) {
    const info = videoInfoRef.current;
    if (!info) return;
    const frameDuration = getFrameDuration(info.fps);
    const strategy = frameCount < 0 ? "floor" : "ceil";
    const next = snapTimeToFrame(currentPreviewTimeRef.current + frameCount * frameDuration, info, strategy);
    syncPreviewTime(next);
  }

  function nudgeStartTime(direction: -1 | 1) {
    const info = videoInfoRef.current;
    if (!info) return;
    const frameDuration = getFrameDuration(info.fps);
    const range = resolveRangeFromStart(startTimeRef.current + direction * frameDuration, "clamp");
    if (!range) return;
    commitRange(range.start, range.end);
    syncPreviewTime(range.start);
  }

  function nudgeEndTime(direction: -1 | 1) {
    const info = videoInfoRef.current;
    if (!info) return;
    const frameDuration = getFrameDuration(info.fps);
    const range = resolveRangeFromEnd(endTimeRef.current + direction * frameDuration, "clamp");
    if (!range) return;
    commitRange(range.start, range.end);
    syncPreviewTime(range.end);
  }

  function shiftClipRange(direction: -1 | 1) {
    const info = videoInfoRef.current;
    if (!info) return;
    const frameDuration = getFrameDuration(info.fps);
    const clipLength = endTimeRef.current - startTimeRef.current;
    if (clipLength <= 0) return;

    let nextStart = startTimeRef.current + direction * frameDuration;
    let nextEnd = endTimeRef.current + direction * frameDuration;

    if (nextStart < 0) {
      nextEnd -= nextStart;
      nextStart = 0;
    }

    if (nextEnd > info.duration) {
      const overflow = nextEnd - info.duration;
      nextStart = Math.max(0, nextStart - overflow);
      nextEnd = info.duration;
    }

    if (nextEnd - nextStart < clipLength) {
      nextEnd = Math.min(info.duration, nextStart + clipLength);
      nextStart = Math.max(0, nextEnd - clipLength);
    }

    commitRange(nextStart, nextEnd);
    syncPreviewTime(direction < 0 ? nextStart : nextEnd);
  }

  function shiftClipRangeBySeconds(seconds: number) {
    const info = videoInfoRef.current;
    if (!info) return;
    const clipLength = endTimeRef.current - startTimeRef.current;
    if (clipLength <= 0) return;

    let nextStart = startTimeRef.current + seconds;
    let nextEnd = endTimeRef.current + seconds;

    if (nextStart < 0) {
      nextEnd -= nextStart;
      nextStart = 0;
    }

    if (nextEnd > info.duration) {
      const overflow = nextEnd - info.duration;
      nextStart = Math.max(0, nextStart - overflow);
      nextEnd = info.duration;
    }

    if (nextEnd - nextStart < clipLength) {
      nextEnd = Math.min(info.duration, nextStart + clipLength);
      nextStart = Math.max(0, nextEnd - clipLength);
    }

    commitRange(nextStart, nextEnd);
    syncPreviewTime(seconds < 0 ? nextStart : nextEnd);
  }

  function nudgeStartTimeBySeconds(seconds: number) {
    const range = resolveRangeFromStart(startTimeRef.current + seconds, "clamp");
    if (!range) return;
    commitRange(range.start, range.end);
    syncPreviewTime(range.start);
  }

  function nudgeEndTimeBySeconds(seconds: number) {
    const range = resolveRangeFromEnd(endTimeRef.current + seconds, "clamp");
    if (!range) return;
    commitRange(range.start, range.end);
    syncPreviewTime(range.end);
  }

  function resetClipRange() {
    const info = videoInfoRef.current;
    if (!info) return;

    clearPendingPreviewTimeout();
    setTimelineDragMode(null);
    setHoverTimelineTime(null);
    cancelStartInputEditing();
    cancelEndInputEditing();
    setPreviewFrameError(false);
    setTimelineFramesError(false);
    setClipPlaybackState(false);
    setPreviewPlaying(false);

    const video = previewVideoRef.current;
    if (video && !video.paused) {
      video.pause();
    }

    commitRange(0, info.duration);
    syncPreviewTime(0);
  }

  function previewClipMiddle() {
    const info = videoInfoRef.current;
    if (!info) return;
    const middle = startTimeRef.current + (endTimeRef.current - startTimeRef.current) / 2;
    syncPreviewTime(snapTimeToFrame(middle, info));
  }

  function snapPreviewIntoClip() {
    if (currentPreviewTimeRef.current < startTimeRef.current) {
      syncPreviewTime(startTimeRef.current);
      return;
    }
    if (currentPreviewTimeRef.current > endTimeRef.current) {
      syncPreviewTime(endTimeRef.current);
      return;
    }
    syncPreviewTime(currentPreviewTimeRef.current);
  }

  function cancelStartInputEditing() {
    setEditingStart(false);
    setStartTimeInput(formatTime(startTimeRef.current));
  }

  function cancelEndInputEditing() {
    setEditingEnd(false);
    setEndTimeInput(formatTime(endTimeRef.current));
  }

  function handleTimelinePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (processing || !videoInfo) return;
    beginTimelineDrag("playhead", event.clientX);
  }

  function handleTimelinePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (processing || timelineDragMode) return;
    const info = videoInfoRef.current;
    if (!info) return;
    setHoverTimelineTime(snapTimeToFrame(getTimelineTimeFromClientX(event.clientX), info));
  }

  function handleTimelinePointerLeave() {
    if (!timelineDragMode) {
      setHoverTimelineTime(null);
    }
  }

  function handleTimelineHandlePointerDown(mode: TimelineDragMode, event: ReactPointerEvent<HTMLButtonElement>) {
    if (processing) return;
    event.stopPropagation();
    beginTimelineDrag(mode, event.clientX);
  }

  function handleTimelineWheel(event: ReactWheelEvent<HTMLDivElement>) {
    if (processing || !videoInfo) return;
    if (event.deltaY === 0) return;

    event.preventDefault();
    const direction: -1 | 1 = event.deltaY > 0 ? 1 : -1;
    if (event.shiftKey) {
      movePreviewBySeconds(direction);
    } else {
      stepPreviewFrame(direction);
    }
  }

  function handleTimeInputWheel(event: ReactWheelEvent<HTMLInputElement>, target: "start" | "end") {
    if (processing || !videoInfo) return;
    if (event.deltaY === 0) return;

    event.preventDefault();
    const direction: -1 | 1 = event.deltaY > 0 ? 1 : -1;
    if (target === "start") {
      if (event.shiftKey) {
        nudgeStartTimeBySeconds(direction);
      } else {
        nudgeStartTime(direction);
      }
    } else if (event.shiftKey) {
      nudgeEndTimeBySeconds(direction);
    } else {
      nudgeEndTime(direction);
    }
  }

  async function loadVideo(path: string) {
    if (!(await ensureVideoPathAvailable(path, "载入视频"))) return;

    const loadRequestId = ++loadRequestIdRef.current;
    previewRequestIdRef.current += 1;
    timelineRequestIdRef.current += 1;
    pendingPreviewSeekRef.current = 0;
    clearPendingPreviewTimeout();
    const preferredStrategy = getPreferredPreviewStrategy(path);
    setClipPlaybackState(false);
    setPreviewPlaying(false);
    setPreviewStrategy(preferredStrategy);
    setPreviewFrame("");
    setPreviewFrameError(false);
    setLoadingPreview(preferredStrategy === "image");
    setLoadingTimelineFrames(true);
    setTimelineFramesError(false);
    lastTimelineFrameCountRef.current = 0;
    setPreviewReady(false);

    const cacheKey = await buildVideoCacheKey(path);
    if (loadRequestIdRef.current !== loadRequestId) return;

    setVideoPath(path);
    setVideoCacheKey(cacheKey);
    setVideoInfo(null);
    setTimelineFrames([]);
    setCurrentPreviewTime(0);
    setProgress(0);
    try {
      const info = await invoke<VideoInfo>("get_video_info", { path });
      if (loadRequestIdRef.current !== loadRequestId) return;
      setVideoInfo(info);
      startTimeRef.current = 0;
      endTimeRef.current = info.duration;
      setStartTime(0);
      setEndTime(info.duration);
      setCurrentPreviewTime(0);
      pendingPreviewSeekRef.current = 0;
      if (preferredStrategy === "image") {
        await loadPreviewFrame(path, 0);
        if (loadRequestIdRef.current !== loadRequestId) return;
      }
    } catch (e) {
      if (loadRequestIdRef.current !== loadRequestId) return;
      setVideoPath("");
      setVideoInfo(null);
      setTimelineFrames([]);
      setLoadingTimelineFrames(false);
      setTimelineFramesError(false);
      setPreviewFrameError(false);
      setCurrentPreviewTime(0);
      toast.error("获取视频信息失败: " + e);
    }
  }

  async function loadPreviewFrame(path: string, time: number) {
    const info = videoInfoRef.current;
    const snappedTime = info ? snapTimeToFrame(time, info) : time;
    const cacheKey = `${videoCacheKey || path}::${snappedTime.toFixed(6)}`;
    const cachedFrame = previewFrameCacheRef.current.get(cacheKey);
    if (cachedFrame) {
      setPreviewFrame(cachedFrame);
      setPreviewFrameError(false);
      setCurrentPreviewTime(snappedTime);
      setLoadingPreview(false);
      return;
    }

    const requestId = ++previewRequestIdRef.current;
    setLoadingPreview(true);
    setPreviewFrameError(false);
    try {
      const frame = await invoke<string>("generate_preview_frame", { path, time: snappedTime });
      if (previewRequestIdRef.current !== requestId) return;
      setPreviewFrame(frame);
      setPreviewFrameError(false);
      setCurrentPreviewTime(snappedTime);
      previewFrameCacheRef.current.set(cacheKey, frame);
      if (previewFrameCacheRef.current.size > 36) {
        const oldestKey = previewFrameCacheRef.current.keys().next().value;
        if (oldestKey) {
          previewFrameCacheRef.current.delete(oldestKey);
        }
      }
    } catch (e) {
      if (previewRequestIdRef.current !== requestId) return;
      console.error("生成预览帧失败:", e);
      setPreviewFrameError(true);
    } finally {
      if (previewRequestIdRef.current === requestId) {
        setLoadingPreview(false);
      }
    }
  }

  function retryStaticPreview() {
    const path = videoPathRef.current;
    if (!path) return;
    void (async () => {
      if (!(await ensureVideoPathAvailable(path, "重试预览"))) return;
      await loadPreviewFrame(path, currentPreviewTimeRef.current);
    })();
  }

  function retryTimelineFrames() {
    const path = videoPathRef.current;
    const info = videoInfoRef.current;
    if (!path || !info) return;
    const count = getTimelineFrameCount(info.duration, timelineWidth);
    lastTimelineFrameCountRef.current = count;
    void (async () => {
      if (!(await ensureVideoPathAvailable(path, "重试缩略帧"))) return;
      await loadTimelineFrames(path, count);
    })();
  }

  async function loadTimelineFrames(path: string, count: number) {
    const requestId = ++timelineRequestIdRef.current;
    const cacheKey = `${videoCacheKey || path}::${count}`;
    const cachedFrames = timelineFramesCacheRef.current.get(cacheKey);
    if (cachedFrames) {
      setTimelineFrames(cachedFrames);
      setLoadingTimelineFrames(false);
      setTimelineFramesError(false);
      return;
    }

    setLoadingTimelineFrames(true);
    setTimelineFramesError(false);
    try {
      const frames = await invoke<string[]>("generate_timeline_frames", { path, count });
      if (timelineRequestIdRef.current !== requestId) return;
      setTimelineFrames(frames);
      timelineFramesCacheRef.current.set(cacheKey, frames);
      if (timelineFramesCacheRef.current.size > 12) {
        const oldestKey = timelineFramesCacheRef.current.keys().next().value;
        if (oldestKey) {
          timelineFramesCacheRef.current.delete(oldestKey);
        }
      }
    } catch (e) {
      if (timelineRequestIdRef.current !== requestId) return;
      console.error("生成时间轴失败:", e);
      setTimelineFramesError(true);
    } finally {
      if (timelineRequestIdRef.current === requestId) {
        setLoadingTimelineFrames(false);
      }
    }
  }

  function updatePreviewDebounced(time: number) {
    clearPendingPreviewTimeout();
    previewTimeoutRef.current = window.setTimeout(() => {
      previewTimeoutRef.current = null;
      const path = videoPathRef.current;
      if (path) {
        void loadPreviewFrame(path, time);
      }
    }, 120);
  }

  async function selectVideo() {
    if (processing) {
      toast.info("当前正在处理，暂时无法更换视频");
      return;
    }

    const file = await open({
      title: "选择视频文件",
      filters: [{ name: "视频文件", extensions: SUPPORTED_VIDEO_EXTENSIONS }],
    });
    if (file && typeof file === "string") {
      await loadVideo(file);
    }
  }

  async function handleCut() {
    const currentVideoPath = videoPathRef.current;
    const currentVideoInfo = videoInfoRef.current;
    const currentStartTime = startTimeRef.current;
    const currentEndTime = endTimeRef.current;

    if (!currentVideoPath || !currentVideoInfo) return;
    if (!(await ensureVideoPathAvailable(currentVideoPath, "截取视频"))) return;

    const ext = getExtension(currentVideoPath) || "mp4";
    const preciseOutputExt = getPreferredPreciseOutputExtension(ext);
    const defaultOutputExt = preciseMode ? preciseOutputExt : ext;
    const outputExtensions = preciseMode
      ? Array.from(new Set([preciseOutputExt, "mp4", "mov", "mkv"]))
      : Array.from(new Set([ext, "mp4"]));
    const baseName = stripExtension(getBaseName(currentVideoPath)) || "video";
    const defaultOutputName = `${baseName}-${formatTimeForFilename(currentStartTime)}-${formatTimeForFilename(currentEndTime)}.${defaultOutputExt}`;
    const outputPath = await save({
      title: "保存截取的视频",
      defaultPath: await buildDefaultOutputPath(defaultOutputName),
      filters: [{ name: preciseMode ? "重编码视频" : "视频文件", extensions: outputExtensions }],
    });
    if (!outputPath) return;

    const finalOutputPath = ensureOutputPathExtension(outputPath, defaultOutputExt);

    if (await isSameVideoPath(currentVideoPath, finalOutputPath)) {
      toast.error("导出路径不能覆盖原视频，请选择新文件名或其他位置");
      return;
    }

    const outputExt = (getExtension(finalOutputPath) || "").toLowerCase();
    const inputExt = ext.toLowerCase();
    if (!preciseMode && outputExt !== inputExt) {
      toast.error("快速模式仅支持保持原视频容器导出。如需输出其他格式，请开启精确模式");
      return;
    }
    if (preciseMode && !isSupportedPreciseOutputExtension(outputExt)) {
      toast.error("精确模式当前仅支持输出 mp4、mov、m4v 或 mkv");
      return;
    }

    if (!preciseMode && clipDuration < 1) {
      toast.info("当前片段不足 1 秒，快速模式可能不够准，建议开启精确模式");
    }

    setProcessing(true);
    setProgress(0);
    try {
      const command = preciseMode ? "cut_video_precise" : "cut_video";
      await invoke(command, {
        input: currentVideoPath,
        output: finalOutputPath,
        startTime: currentStartTime,
        endTime: currentEndTime,
      });
      await rememberLastOutputDir(finalOutputPath);
      toast.success("截取完成");
    } catch (e) {
      const message = String(e);
      if (!message.includes("取消")) {
        toast.error("截取失败: " + e);
      } else {
        toast.info("已取消截取");
      }
    } finally {
      setProcessing(false);
      setProgress(0);
    }
  }

  async function cancelCut() {
    await invoke("cancel_video_cut");
    setProcessing(false);
    setProgress(0);
  }

  const clipDuration = Math.max(0, endTime - startTime);
  const timelineFrameTargetCount = videoInfo ? getTimelineFrameCount(videoInfo.duration, timelineWidth) : 0;
  const currentPreviewFrameNumber = getFrameNumber(currentPreviewTime, videoInfo);
  const startFrameNumber = getFrameNumber(startTime, videoInfo);
  const endFrameNumber = getFrameNumber(endTime, videoInfo);
  const clipFrameCount = getClipFrameCount(startTime, endTime, videoInfo);
  const currentPreviewInClip = currentPreviewTime >= startTime && currentPreviewTime <= endTime;
  const offsetFromStart = currentPreviewInClip ? currentPreviewTime - startTime : null;
  const offsetToEnd = currentPreviewInClip ? endTime - currentPreviewTime : null;
  const clipProgressPercent = currentPreviewInClip && clipDuration > 0 ? ((currentPreviewTime - startTime) / clipDuration) * 100 : null;
  const previewClipStatus =
    currentPreviewTime < startTime
      ? `当前预览点在片段前 ${formatSignedOffsetLabel(currentPreviewTime - startTime)}`
      : currentPreviewTime > endTime
        ? `当前预览点在片段后 ${formatSignedOffsetLabel(currentPreviewTime - endTime)}`
        : "当前预览点在片段内";
  const currentPreviewPercent = videoInfo && videoInfo.duration > 0 ? (currentPreviewTime / videoInfo.duration) * 100 : 0;
  const currentPreviewIndicatorPercent = clamp(currentPreviewPercent, 2, 98);
  const hoverTimelinePercent = videoInfo && videoInfo.duration > 0 && hoverTimelineTime !== null ? (hoverTimelineTime / videoInfo.duration) * 100 : null;
  const hoverTimelineIndicatorPercent = hoverTimelinePercent === null ? null : clamp(hoverTimelinePercent, 2, 98);
  const hoverTimelineFrameNumber = hoverTimelineTime === null ? null : getFrameNumber(hoverTimelineTime, videoInfo);
  const showHoverTimelineIndicator =
    hoverTimelineIndicatorPercent !== null && Math.abs(hoverTimelineIndicatorPercent - currentPreviewIndicatorPercent) >= 3;
  const timelineStartPercent = videoInfo && videoInfo.duration > 0 ? (startTime / videoInfo.duration) * 100 : 0;
  const timelineEndPercent = videoInfo && videoInfo.duration > 0 ? (endTime / videoInfo.duration) * 100 : 0;
  const timelineStartIndicatorPercent = clamp(timelineStartPercent, 2, 98);
  const timelineEndIndicatorPercent = clamp(timelineEndPercent, 2, 98);
  const controlUnavailableReason =
    processing
      ? "处理中：更换视频、时间轴拖拽、设点、微调、重试与模式切换已锁定。"
      : previewStrategy !== "video"
        ? "当前为静态预览：播放片段与循环片段不可用，其余定位和导出仍可继续。"
        : !previewReady
          ? "视频预览尚未就绪：播放片段与循环片段暂不可用。"
          : !currentPreviewInClip
            ? "当前预览点在片段外：“回片段”可一键跳回最近边界。"
            : null;
  const controlUnavailableBadge =
    processing
      ? { tone: "warning" as const, label: "编辑已锁定" }
      : previewStrategy !== "video"
        ? { tone: "warning" as const, label: "静态预览" }
        : !previewReady
          ? { tone: "info" as const, label: "预览未就绪" }
          : !currentPreviewInClip
            ? { tone: "info" as const, label: "预览点在片段外" }
            : null;
  const exportUnavailableReason =
    processing
      ? "处理中：请等待当前任务结束"
      : clipDuration <= 0
        ? "当前片段长度无效"
        : null;
  const primaryActionLabel =
    processing
      ? "处理中…"
      : clipDuration <= 0
        ? "先设定片段"
        : "开始截取";
  const playClipButtonLabel =
    processing
      ? "处理中"
      : previewStrategy !== "video"
        ? "静态预览"
        : !previewReady
          ? "等待就绪"
          : clipPlaybackActive
            ? "暂停片段"
            : "播放片段";
  const loopClipButtonLabel =
    processing
      ? "处理中"
      : previewStrategy !== "video"
        ? "静态预览"
        : !previewReady
          ? "等待就绪"
          : "循环片段";
  const snapPreviewButtonLabel = currentPreviewInClip ? "已在片段内" : "回片段";
  const playClipButtonTitle =
    processing
      ? "处理中：播放片段暂不可用"
      : previewStrategy !== "video"
        ? "当前为静态预览：播放片段不可用"
        : !previewReady
          ? "视频预览尚未就绪"
          : "空格";
  const loopClipButtonTitle =
    processing
      ? "处理中：循环片段暂不可用"
      : previewStrategy !== "video"
        ? "当前为静态预览：循环片段不可用"
        : !previewReady
          ? "视频预览尚未就绪"
          : "R";
  const snapPreviewButtonTitle =
    processing ? "处理中：回片段暂不可用" : currentPreviewInClip ? "当前预览点已在片段内" : "B";
  const timelineStatusLabel =
    timelineDragMode === "start" ? "正在调整开始时间" :
    timelineDragMode === "end" ? "正在调整结束时间" :
    timelineDragMode === "playhead" ? "正在调整预览游标" :
    "拖动两端调整范围，点击时间轴切换预览帧，滚轮逐帧微调，Shift+滚轮按秒移动。";

  return (
    <div className="space-y-6 p-6">
      {!videoPath ? (
        <>
          <Card className="overflow-hidden">
            <CardContent className="px-5 py-5">
              <div
                onClick={selectVideo}
                className={cn("drop-zone flex flex-col items-center justify-center", dragging && "dragging")}
              >
                <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-[22px] bg-white text-3xl shadow-[0_16px_34px_rgba(15,23,42,0.08)]">
                  {dragging ? "📂" : "🎬"}
                </div>
                <div className="text-lg font-semibold text-slate-900">{dragging ? "松开以载入视频" : "拖入视频，或点击选择"}</div>
              </div>
            </CardContent>
          </Card>
        </>
      ) : (
        <>
          {videoInfo && (
            <Card>
              <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-2 px-5 py-4 text-sm">
                <div className="flex items-center gap-2">
                  <span className="text-slate-400">总时长</span>
                  <span className="font-medium text-slate-900">{formatTime(videoInfo.duration)}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-slate-400">当前片段</span>
                  <span className="font-medium text-slate-900">{formatTime(clipDuration)}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-slate-400">画面规格</span>
                  <span className="font-medium text-slate-900">{videoInfo.width}×{videoInfo.height}</span>
                </div>
                {showAdvancedControls && (
                  <>
                    <div className="flex items-center gap-2">
                      <span className="text-slate-400">帧率</span>
                      <span className="font-medium text-slate-900">{formatFps(videoInfo.fps)} fps</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-slate-400">当前帧</span>
                      <span className="font-medium text-slate-900">#{currentPreviewFrameNumber}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-slate-400">片段帧数</span>
                      <span className="font-medium text-slate-900">{clipFrameCount}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-slate-400">距开始</span>
                      <span className="font-medium text-slate-900">{offsetFromStart === null ? "--" : formatTime(offsetFromStart)}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-slate-400">距结束</span>
                      <span className="font-medium text-slate-900">{offsetToEnd === null ? "--" : formatTime(offsetToEnd)}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-slate-400">片段内位置</span>
                      <span className="font-medium text-slate-900">{clipProgressPercent === null ? "--" : `${clipProgressPercent.toFixed(1)}%`}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-slate-400">预览状态</span>
                      <span className={cn("font-medium", currentPreviewInClip ? "text-emerald-700" : "text-amber-700")}>{previewClipStatus}</span>
                    </div>
                  </>
                )}
                <div className="ml-auto flex items-center gap-3 rounded-full border border-slate-200 bg-slate-50 px-3 py-2">
                  <div className="text-right">
                    <div className="text-[11px] font-medium text-slate-700">高级微调</div>
                    <div className="text-[10px] text-slate-400">{showAdvancedControls ? "已展开" : "默认简洁"}</div>
                  </div>
                  <Switch checked={showAdvancedControls} onCheckedChange={setShowAdvancedControls} disabled={processing} />
                </div>
              </CardContent>
            </Card>
          )}

          <div className="grid gap-6 xl:grid-cols-[minmax(0,1.55fr)_380px]">
            <Card className="overflow-hidden">
              <CardHeader>
                <div>
                  <CardTitle>预览与时间轴</CardTitle>
                  <div className="mt-1 text-sm text-slate-500">{getBaseName(videoPath)}</div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone="info">{preciseMode ? "精确模式" : "快速模式"}</Badge>
                  <Button variant="secondary" size="sm" onClick={selectVideo} disabled={processing}>
                    更换视频
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="overflow-hidden rounded-[24px] bg-slate-950">
                  <div className="relative flex min-h-[360px] items-center justify-center px-4 py-4">
                    {previewStrategy === "video" && previewVideoSrc ? (
                      <video
                        key={previewVideoSrc}
                        ref={previewVideoRef}
                        src={previewVideoSrc}
                        controls
                        playsInline
                        preload="metadata"
                        className="max-h-[420px] w-full object-contain"
                        onLoadedMetadata={handlePreviewLoadedMetadata}
                        onTimeUpdate={handlePreviewTimeUpdate}
                        onSeeked={handlePreviewTimeUpdate}
                        onPlay={handlePreviewPlay}
                        onPause={handlePreviewPause}
                        onError={handlePreviewError}
                      />
                    ) : previewFrame ? (
                      <img src={previewFrame} alt="视频预览" className="max-h-[420px] w-full object-contain" />
                    ) : (
                      <div className="text-sm text-slate-400">
                        {previewFrameError ? "静态预览生成失败" : loadingPreview ? "加载预览中…" : "等待载入视频"}
                      </div>
                    )}
                    <div className="absolute bottom-4 left-4 rounded-full bg-slate-950/80 px-3 py-1 text-xs font-medium text-white">
                      {formatTime(currentPreviewTime)}
                    </div>
                    {previewStrategy === "video" && !previewReady && previewVideoSrc && (
                      <div className="absolute right-4 top-4 rounded-full bg-slate-950/72 px-3 py-1 text-xs text-white">
                        载入预览中…
                      </div>
                    )}
                    {previewStrategy === "image" && (
                      <div className="absolute right-4 top-4 rounded-full bg-slate-950/72 px-3 py-1 text-xs text-white">
                        静态预览
                      </div>
                    )}
                    {previewStrategy === "image" && loadingPreview && previewFrame && (
                      <div className="absolute right-4 top-4 rounded-full bg-slate-950/72 px-3 py-1 text-xs text-white">
                        更新中…
                      </div>
                    )}
                    {previewStrategy === "image" && previewFrameError && (
                      <div className="absolute right-4 bottom-4">
                        <Button variant="secondary" size="sm" className="h-8 px-3 text-[11px]" onClick={retryStaticPreview} disabled={processing}>
                          重试预览
                        </Button>
                      </div>
                    )}
                    {processing && (
                      <div className="absolute inset-0 z-10 flex items-center justify-center bg-slate-950/38 backdrop-blur-[1px]">
                        <div className="rounded-full bg-slate-950/82 px-4 py-2 text-xs text-white">
                          处理中，已锁定预览编辑
                        </div>
                      </div>
                    )}
                  </div>

                  {videoInfo && (
                    <div className="border-t border-white/10 px-3 py-3">
                      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                        <div className="text-[11px] text-slate-400">
                          缩略帧
                          {timelineFrames.length > 0 ? ` ${timelineFrames.length}/${timelineFrameTargetCount}` : ""}
                        </div>
                        {controlUnavailableBadge && (
                          <Badge tone={controlUnavailableBadge.tone}>{controlUnavailableBadge.label}</Badge>
                        )}
                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            variant={clipPlaybackActive ? "primary" : "ghost"}
                            size="sm"
                            className="h-7 px-2.5 text-[11px]"
                            onClick={() => void toggleClipPlayback()}
                            disabled={processing || previewStrategy !== "video" || !previewReady || clipDuration <= 0}
                            aria-pressed={clipPlaybackActive}
                            title={playClipButtonTitle}
                          >
                            {playClipButtonLabel}
                          </Button>
                          <div className="flex items-center gap-2 rounded-full border border-white/10 bg-slate-900/50 px-2.5 py-1">
                            <span className="text-[11px] text-slate-300">{loopClipButtonLabel}</span>
                            <Switch
                              checked={loopClipPlayback}
                              onCheckedChange={setLoopClipPlayback}
                              disabled={processing || previewStrategy !== "video" || !previewReady || clipDuration <= 0}
                              title={loopClipButtonTitle}
                              className="h-5 w-9"
                            />
                          </div>
                          <Button variant="ghost" size="sm" className="h-7 px-2.5 text-[11px]" onClick={() => stepPreviewFrame(-1)} disabled={processing} title="左方向键">
                            上一帧
                          </Button>
                          <Button variant="ghost" size="sm" className="h-7 px-2.5 text-[11px]" onClick={() => stepPreviewFrame(1)} disabled={processing} title="右方向键">
                            下一帧
                          </Button>
                          <Button variant="ghost" size="sm" className="h-7 px-2.5 text-[11px]" onClick={applyCurrentFrameToStart} disabled={processing} title="[ / I">
                            设起点
                          </Button>
                          <Button variant="ghost" size="sm" className="h-7 px-2.5 text-[11px]" onClick={applyCurrentFrameToEnd} disabled={processing} title="] / O">
                            设终点
                          </Button>
                        </div>
                      </div>
                      {showAdvancedControls && (
                        <div className="mb-2 flex flex-wrap items-center gap-2">
                          <Button variant="ghost" size="sm" className="h-7 px-2.5 text-[11px]" onClick={() => syncPreviewTime(startTimeRef.current)} disabled={processing} title="Home">
                            看起点
                          </Button>
                          <Button variant="ghost" size="sm" className="h-7 px-2.5 text-[11px]" onClick={snapPreviewIntoClip} disabled={processing || currentPreviewInClip} title={snapPreviewButtonTitle}>
                            {snapPreviewButtonLabel}
                          </Button>
                          <Button variant="ghost" size="sm" className="h-7 px-2.5 text-[11px]" onClick={previewClipMiddle} disabled={processing} title="M">
                            看中点
                          </Button>
                          <Button variant="ghost" size="sm" className="h-7 px-2.5 text-[11px]" onClick={() => syncPreviewTime(endTimeRef.current)} disabled={processing} title="End">
                            看终点
                          </Button>
                          <Button variant="ghost" size="sm" className="h-7 px-2.5 text-[11px]" onClick={() => shiftClipRange(-1)} disabled={processing} title=",">
                            左移片段
                          </Button>
                          <Button variant="ghost" size="sm" className="h-7 px-2.5 text-[11px]" onClick={() => shiftClipRange(1)} disabled={processing} title=".">
                            右移片段
                          </Button>
                        </div>
                      )}
                      {timelineFrames.length > 0 ? (
                        <div className="flex gap-2 overflow-x-auto pb-1">
                          {timelineFrames.map((frame, index) => {
                            const rawFrameTime = (videoInfo.duration / (timelineFrames.length + 1)) * (index + 1);
                            const frameTime = snapTimeToFrame(rawFrameTime, videoInfo);
                            const activeFrame = Math.abs(frameTime - currentPreviewTime) <= videoInfo.duration / (timelineFrames.length + 1) / 2;
                            const frameNumber = getFrameNumber(frameTime, videoInfo);
                            return (
                              <button
                                key={index}
                                className={cn(
                                  "group min-w-[92px] overflow-hidden rounded-xl border bg-slate-900/70 text-left transition",
                                  activeFrame ? "border-amber-300/80 ring-1 ring-amber-300/40" : "border-white/10 hover:border-white/20"
                                )}
                                disabled={processing}
                                title={`${formatTime(frameTime)} · #${frameNumber}`}
                                onClick={() => {
                                  syncPreviewTime(frameTime);
                                }}
                              >
                                <img src={frame} alt="" className="h-12 w-full object-cover transition group-hover:opacity-100" />
                                <div className="px-2 py-1 text-[10px] text-slate-300">{formatTime(frameTime)}</div>
                              </button>
                            );
                          })}
                        </div>
                      ) : (
                        <div className="rounded-xl border border-dashed border-white/10 px-3 py-3 text-[11px] text-slate-400">
                          {loadingTimelineFrames ? "缩略帧生成中…" : "暂无缩略帧，也可以直接用下方时间轴和预览操作。"}
                        </div>
                      )}
                      {controlUnavailableReason && (
                        <div className="mt-2 rounded-xl border border-white/10 bg-slate-950/40 px-3 py-2 text-[11px] text-slate-300">
                          {controlUnavailableReason}
                        </div>
                      )}
                    </div>
                  )}
                  {loadingTimelineFrames && (
                    <div className="border-t border-white/10 px-3 py-3 text-[11px] text-slate-400">
                      正在生成时间轴缩略帧…
                    </div>
                  )}
                  {timelineFramesError && (
                    <div className="border-t border-white/10 px-3 py-3">
                      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-amber-200/90">
                        <span>时间轴缩略帧生成失败，可继续拖动时间轴和预览后导出。</span>
                        <Button variant="secondary" size="sm" className="h-7 px-2.5 text-[11px]" onClick={retryTimelineFrames} disabled={processing}>
                          重试缩略帧
                        </Button>
                      </div>
                    </div>
                  )}

                  <div className="border-t border-white/10 px-3 py-3">
                    <div className="mb-2 flex items-center justify-between text-[11px] text-slate-400">
                      <span>{timelineStatusLabel}</span>
                      <span>{formatTime(startTime)} - {formatTime(endTime)}</span>
                    </div>
                    <div
                      ref={timelineRef}
                      className={cn(
                        "relative h-14 overflow-hidden rounded-2xl border bg-[linear-gradient(180deg,rgba(15,23,42,0.82),rgba(30,41,59,0.92))] select-none touch-none transition",
                        timelineDragMode ? "border-amber-300/40 ring-1 ring-amber-300/20" : "border-white/10"
                      )}
                      onPointerDown={handleTimelinePointerDown}
                      onPointerMove={handleTimelinePointerMove}
                      onPointerLeave={handleTimelinePointerLeave}
                      onWheel={handleTimelineWheel}
                    >
                      <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(51,109,255,0.12),rgba(255,255,255,0.02),rgba(51,109,255,0.12))]" />

                      <div className="absolute inset-y-0 left-0 bg-slate-950/60" style={{ width: `${timelineStartPercent}%` }} />
                      <div className="absolute inset-y-0 right-0 bg-slate-950/60" style={{ width: `${100 - timelineEndPercent}%` }} />
                      <div
                        className="absolute inset-y-0 border-x border-[rgba(147,197,253,0.9)] bg-[rgba(59,130,246,0.22)]"
                        style={{
                          left: `${timelineStartPercent}%`,
                          width: `${Math.max(0, timelineEndPercent - timelineStartPercent)}%`,
                        }}
                      />
                      <div
                        className="absolute inset-y-0 z-10 w-px -translate-x-1/2 bg-amber-300/90 shadow-[0_0_0_1px_rgba(253,224,71,0.14)]"
                        style={{ left: `${currentPreviewIndicatorPercent}%` }}
                      />
                      {showHoverTimelineIndicator && !timelineDragMode && (
                        <div
                          className="absolute inset-y-0 z-[9] w-px -translate-x-1/2 bg-sky-300/80 shadow-[0_0_0_1px_rgba(125,211,252,0.16)]"
                          style={{ left: `${hoverTimelineIndicatorPercent}%` }}
                        />
                      )}
                      <div
                        className="absolute -top-1 z-10 -translate-x-1/2 -translate-y-full rounded-full bg-slate-950/92 px-2 py-1 text-[10px] font-medium text-amber-100 shadow-[0_8px_18px_rgba(15,23,42,0.28)]"
                        style={{ left: `${currentPreviewIndicatorPercent}%` }}
                      >
                        {formatTime(currentPreviewTime)} · #{currentPreviewFrameNumber}
                      </div>
                      {showHoverTimelineIndicator && hoverTimelineTime !== null && !timelineDragMode && (
                        <div
                          className="absolute -top-1 z-[9] -translate-x-1/2 -translate-y-full rounded-full bg-sky-950/90 px-2 py-1 text-[10px] font-medium text-sky-100 shadow-[0_8px_18px_rgba(2,132,199,0.18)]"
                          style={{ left: `${hoverTimelineIndicatorPercent}%` }}
                        >
                          {formatTime(hoverTimelineTime)}{hoverTimelineFrameNumber ? ` · #${hoverTimelineFrameNumber}` : ""}
                        </div>
                      )}
                      {timelineDragMode === "start" && (
                        <div
                          className="absolute -top-1 z-[11] -translate-x-1/2 -translate-y-full rounded-full bg-[var(--brand-600)]/92 px-2 py-1 text-[10px] font-medium text-white shadow-[0_8px_18px_rgba(37,99,235,0.22)]"
                          style={{ left: `${timelineStartIndicatorPercent}%` }}
                        >
                          {formatTime(startTime)} · #{startFrameNumber}
                        </div>
                      )}
                      {timelineDragMode === "end" && (
                        <div
                          className="absolute -top-1 z-[11] -translate-x-1/2 -translate-y-full rounded-full bg-rose-500/92 px-2 py-1 text-[10px] font-medium text-white shadow-[0_8px_18px_rgba(244,63,94,0.22)]"
                          style={{ left: `${timelineEndIndicatorPercent}%` }}
                        >
                          {formatTime(endTime)} · #{endFrameNumber}
                        </div>
                      )}

                      <button
                        className="absolute inset-y-0 z-20 w-6 -translate-x-1/2 cursor-ew-resize"
                        style={{ left: `${timelineStartPercent}%` }}
                        onPointerDown={(event) => handleTimelineHandlePointerDown("start", event)}
                        aria-label="调整开始时间"
                        disabled={processing}
                      >
                        <span className="absolute left-1/2 top-1 h-4 w-2 -translate-x-1/2 bg-[var(--brand-500)] [clip-path:polygon(50%_100%,0_0,100%_0)] drop-shadow-[0_4px_8px_rgba(15,23,42,0.28)]" />
                      </button>
                      <button
                        className="absolute inset-y-0 z-20 w-6 -translate-x-1/2 cursor-ew-resize"
                        style={{ left: `${timelineEndPercent}%` }}
                        onPointerDown={(event) => handleTimelineHandlePointerDown("end", event)}
                        aria-label="调整结束时间"
                        disabled={processing}
                      >
                        <span className="absolute left-1/2 top-1 h-4 w-2 -translate-x-1/2 bg-rose-400 [clip-path:polygon(50%_100%,0_0,100%_0)] drop-shadow-[0_4px_8px_rgba(15,23,42,0.28)]" />
                      </button>
                    </div>
                    <div className="mt-2 grid grid-cols-3 text-[11px] text-slate-400">
                      <span>开始 {formatTime(startTime)} · #{startFrameNumber}</span>
                      <span className="text-center">片段 {formatTime(clipDuration)}</span>
                      <span className="text-right">结束 {formatTime(endTime)} · #{endFrameNumber}</span>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <div>
                  <CardTitle>截取参数</CardTitle>
                </div>
              </CardHeader>
              <CardContent className="space-y-5">
                <div className="grid gap-4">
                  <div className="grid gap-3 md:grid-cols-3">
                    <div>
                      <div className="mb-2 text-sm font-medium text-slate-800">开始</div>
                      <Input
                        value={editingStart ? startTimeInput : formatTime(startTime)}
                        placeholder="mm:ss.000"
                        onFocus={(event) => {
                          setEditingStart(true);
                          setStartTimeInput(formatTime(startTime));
                          window.requestAnimationFrame(() => {
                            event.currentTarget.select();
                          });
                        }}
                        onChange={(event) => setStartTimeInput(event.target.value)}
                        onWheel={(event) => handleTimeInputWheel(event, "start")}
                        onBlur={() => {
                          setEditingStart(false);
                          const parsed = parseTimeInput(startTimeInput);
                          if (parsed === null) {
                            toast.error("开始时间格式无效，请输入秒数或 mm:ss.ms / hh:mm:ss.ms");
                            return;
                          }
                          const range = resolveRangeFromStart(parsed, "shift-end");
                          if (!range) return;
                          commitRange(range.start, range.end);
                          syncPreviewTime(range.start);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            (event.target as HTMLInputElement).blur();
                          } else if (event.key === "Escape") {
                            event.preventDefault();
                            cancelStartInputEditing();
                            (event.target as HTMLInputElement).blur();
                          }
                        }}
                        className="font-mono"
                        disabled={processing}
                      />
                      {showAdvancedControls && (
                        <div className="mt-2 flex gap-2">
                          <Button variant="ghost" size="sm" className="h-7 flex-1 px-2 text-[11px]" onClick={() => nudgeStartTime(-1)} disabled={processing}>
                            -1 帧
                          </Button>
                          <Button variant="ghost" size="sm" className="h-7 flex-1 px-2 text-[11px]" onClick={() => nudgeStartTime(1)} disabled={processing}>
                            +1 帧
                          </Button>
                        </div>
                      )}
                    </div>

                    <div>
                      <div className="mb-2 text-sm font-medium text-slate-800">时长</div>
                      <div className="flex h-11 items-center rounded-xl border border-slate-200 bg-slate-50 px-3 font-mono text-sm text-slate-900">
                        {formatTime(clipDuration)}
                      </div>
                    </div>

                    <div>
                      <div className="mb-2 text-sm font-medium text-slate-800">结束</div>
                      <Input
                        value={editingEnd ? endTimeInput : formatTime(endTime)}
                        placeholder="mm:ss.000"
                        onFocus={(event) => {
                          setEditingEnd(true);
                          setEndTimeInput(formatTime(endTime));
                          window.requestAnimationFrame(() => {
                            event.currentTarget.select();
                          });
                        }}
                        onChange={(event) => setEndTimeInput(event.target.value)}
                        onWheel={(event) => handleTimeInputWheel(event, "end")}
                        onBlur={() => {
                          setEditingEnd(false);
                          const parsed = parseTimeInput(endTimeInput);
                          if (parsed === null) {
                            toast.error("结束时间格式无效，请输入秒数或 mm:ss.ms / hh:mm:ss.ms");
                            return;
                          }
                          const range = resolveRangeFromEnd(parsed, "shift-start");
                          if (!range) return;
                          commitRange(range.start, range.end);
                          syncPreviewTime(range.end);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            (event.target as HTMLInputElement).blur();
                          } else if (event.key === "Escape") {
                            event.preventDefault();
                            cancelEndInputEditing();
                            (event.target as HTMLInputElement).blur();
                          }
                        }}
                        className="font-mono"
                        disabled={processing}
                      />
                      {showAdvancedControls && (
                        <div className="mt-2 flex gap-2">
                          <Button variant="ghost" size="sm" className="h-7 flex-1 px-2 text-[11px]" onClick={() => nudgeEndTime(-1)} disabled={processing}>
                            -1 帧
                          </Button>
                          <Button variant="ghost" size="sm" className="h-7 flex-1 px-2 text-[11px]" onClick={() => nudgeEndTime(1)} disabled={processing}>
                            +1 帧
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>

                  {videoInfo && (
                    <>
                      <div className="text-[11px] text-slate-400">
                        {showAdvancedControls
                          ? (
                            <>
                              拖动时间轴左手柄调整开始，右手柄调整结束。主预览会按帧吸附到当前位置。
                              {preciseMode ? " 导出结果会更接近当前预览帧。" : " 快速模式导出可能受关键帧影响，与预览存在轻微偏差。"}
                              {previewStrategy === "video"
                                ? " 快捷键：空格或 L 播放片段，K 暂停，左右逐帧，Shift+左右快进退 1 秒，J 或 PageUp/PageDown 跨 10 帧，逗号/句号整体平移片段，Shift+逗号/句号按秒平移，Home/End 看起终点，B 回片段，M 看中点，[ 或 I 设开始，] 或 O 设结束，R 切换循环。"
                                : " 当前为静态预览，可继续逐帧定位和导出。"}
                            </>
                          )
                          : "默认保留高频操作。更多预览指标、回看与整段平移动作可在“展开高级微调”中查看。"}
                      </div>
                    </>
                  )}
                </div>

                <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                  <div className="mb-3 text-sm font-medium text-slate-800">重置</div>
                  <div className="grid gap-2">
                    <Button
                      variant="secondary"
                      className="w-full justify-between"
                      onClick={resetClipRange}
                      disabled={processing}
                      title="恢复整段、停止播放并回到开头"
                    >
                      <span>重置片段</span>
                      <span className="text-[11px] text-slate-500">恢复整段并回到开头</span>
                    </Button>
                  </div>
                  <div className="mt-2 text-[11px] text-slate-400">
                    恢复整段并回到开头，不改长期偏好。
                  </div>
                </div>

                <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium text-slate-800">精确模式</div>
                      <div className="text-[11px] text-slate-500">更准，但更慢。</div>
                    </div>
                    <Switch checked={preciseMode} onCheckedChange={setPreciseMode} disabled={processing} />
                  </div>
                  <div className="mt-2 text-[11px] text-slate-500">
                    {preciseMode
                      ? "已开启：重新编码，结果更贴近预览。"
                      : "已关闭：无损更快，但首尾可能有轻微偏差。"}
                  </div>
                  {!preciseMode && clipDuration > 0 && clipDuration < 1 && (
                    <div className="mt-2 text-[11px] text-amber-700">
                      片段不足 1 秒，建议开精确模式。
                    </div>
                  )}
                  {previewStrategy === "video" && showAdvancedControls && (
                    <div className="mt-2 text-[11px] text-slate-400">
                      {previewPlaying
                        ? clipPlaybackActive
                          ? "片段正在预览中。"
                          : "视频正在播放。"
                        : clipPlaybackActive
                          ? "片段已暂停。"
                          : "可以直接拖动定位，或用“播放片段”确认首尾。 "}
                    </div>
                  )}
                </div>

                {processing && preciseMode && (
                  <div className="space-y-2 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-slate-800">正在编码</span>
                      <span className="font-mono text-[var(--brand-600)]">{progress.toFixed(1)}%</span>
                    </div>
                    <Progress value={progress} />
                    <div className="text-[11px] text-slate-400">已锁定编辑，按 `Esc` 可取消。</div>
                  </div>
                )}

                  <div className="space-y-3 border-t border-slate-100 pt-4">
                    <Button variant="primary" className="w-full" onClick={handleCut} disabled={processing || clipDuration <= 0}>
                      {primaryActionLabel}
                    </Button>
                    {exportUnavailableReason && (
                      <div className="text-center text-xs text-slate-400">{exportUnavailableReason}</div>
                    )}
                  {processing && preciseMode && (
                    <Button variant="danger" className="w-full" onClick={cancelCut}>
                      取消截取
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
