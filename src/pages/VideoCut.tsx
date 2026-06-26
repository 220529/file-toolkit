import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type SyntheticEvent, type WheelEvent as ReactWheelEvent } from "react";
import { dirname, normalize, resolve } from "@tauri-apps/api/path";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  cancelVideoCut,
  cutVideo,
  getPathMetadata,
  getVideoInfo,
  pathExists,
  type PathMetadata,
  type VideoInfo,
} from "../api/tauri";
import { useTaskReporter } from "../components/TaskCenter";
import { useToast } from "../components/Toast";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Icon } from "../components/ui/icon";
import { Input } from "../components/ui/input";
import { Progress } from "../components/ui/progress";
import { Switch } from "../components/ui/switch";
import { useElementWidth } from "../hooks/useElementWidth";
import { useWindowDrop } from "../hooks/useWindowDrop";
import { cn } from "../utils/cn";
import { safeListen } from "../utils/tauriEvent";
import { getBaseName, getExtension, stripExtension } from "../utils/path";
import { useTimelineDragListeners } from "./videoCut/useTimelineDragListeners";
import { VideoCutPreviewTimeline } from "./videoCut/VideoCutPreviewTimeline";
import { useVideoCutPreviewFrames } from "./videoCut/useVideoCutPreviewFrames";
import { useVideoCutPreferences } from "./videoCut/useVideoCutPreferences";
import { useVideoCutKeyboardShortcuts } from "./videoCut/useVideoCutKeyboardShortcuts";
import { getVideoCutViewState } from "./videoCut/viewState";
import {
  SUPPORTED_VIDEO_EXTENSIONS,
  clamp,
  ensureOutputPathExtension,
  formatFps,
  formatTime,
  formatTimeForFilename,
  getFrameDuration,
  getMinClipDuration,
  getPreferredPreciseOutputExtension,
  getPreferredPreviewStrategy,
  isSupportedPreciseOutputExtension,
  parseTimeInput,
  snapTimeToFrame,
} from "./videoCut/utils";

type TimelineDragMode = "playhead" | "start" | "end";
type PlaybackMode = "manual" | "clip";

const LAST_OUTPUT_DIR_STORAGE_KEY = "video-cut-last-output-dir";

export default function VideoCut({ active = true }: { active?: boolean }) {
  const [videoPath, setVideoPath] = useState("");
  const [videoInfo, setVideoInfo] = useState<VideoInfo | null>(null);
  const [startTime, setStartTime] = useState(0);
  const [endTime, setEndTime] = useState(0);
  const [processing, setProcessing] = useState(false);
  const {
    preciseMode,
    setPreciseMode,
    loopClipPlayback,
    setLoopClipPlayback,
    showAdvancedControls,
    setShowAdvancedControls,
  } = useVideoCutPreferences();
  const [previewStrategy, setPreviewStrategy] = useState<"video" | "image">("video");
  const [currentPreviewTime, setCurrentPreviewTime] = useState(0);
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const [clipPlaybackActive, setClipPlaybackActive] = useState(false);
  const [hoverTimelineTime, setHoverTimelineTime] = useState<number | null>(null);
  const loadRequestIdRef = useRef(0);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const timelineWidth = useElementWidth(timelineRef, [videoPath, videoInfo]);
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  const previewSeekRafRef = useRef<number | null>(null);
  const pendingPreviewSeekRef = useRef<number | null>(null);
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
  const [previewReady, setPreviewReady] = useState(false);
  const toast = useToast();
  const task = useTaskReporter("video-cut");
  videoInfoRef.current = videoInfo;
  videoPathRef.current = videoPath;
  startTimeRef.current = startTime;
  endTimeRef.current = endTime;
  currentPreviewTimeRef.current = currentPreviewTime;
  loopClipPlaybackRef.current = loopClipPlayback;
  const {
    previewFrame,
    timelineFrames,
    loadingPreview,
    loadingTimelineFrames,
    previewFrameError,
    timelineFramesError,
    loadPreviewFrame,
    updatePreviewFrameDebounced,
    retryStaticPreview,
    retryTimelineFrames,
    cancelPendingPreviewLoads,
    clearPendingPreviewTimeout,
    setVideoCacheKey,
    preparePreviewFramesForVideoLoad,
    clearTimelineFrames,
    resetPreviewFramesAfterVideoLoadFailure,
    clearPreviewFrameErrors,
  } = useVideoCutPreviewFrames({
    videoPath,
    videoInfo,
    timelineWidth,
    videoPathRef,
    videoInfoRef,
    currentPreviewTimeRef,
    setCurrentPreviewTime,
    ensureVideoPathAvailable,
  });
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
  useVideoCutKeyboardShortcuts({
    active,
    videoInfo,
    processing,
    preciseMode,
    previewStrategy,
    previewReady,
    previewVideoRef,
    startTimeRef,
    endTimeRef,
    onCancelCut: cancelCut,
    onToggleClipPlayback: toggleClipPlayback,
    onMovePreviewBySeconds: movePreviewBySeconds,
    onStepPreviewFrame: stepPreviewFrame,
    onMovePreviewByFrames: movePreviewByFrames,
    onShiftClipRangeBySeconds: shiftClipRangeBySeconds,
    onShiftClipRange: shiftClipRange,
    onApplyCurrentFrameToStart: applyCurrentFrameToStart,
    onApplyCurrentFrameToEnd: applyCurrentFrameToEnd,
    onSyncPreviewTime: syncPreviewTime,
    onPreviewClipMiddle: previewClipMiddle,
    onSnapPreviewIntoClip: snapPreviewIntoClip,
    onToggleLoopClipPlayback: () => setLoopClipPlayback((current) => !current),
  });
  useTimelineDragListeners({
    mode: timelineDragMode,
    onDrag: updateTimelineDrag,
    onDragEnd: () => setTimelineDragMode(null),
  });

  useEffect(() => {
    if (!active) return;

    return safeListen("video-progress", (event) => {
      setProgress(event.payload);
    });
  }, [active]);

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
      if (previewSeekRafRef.current !== null) {
        window.cancelAnimationFrame(previewSeekRafRef.current);
        previewSeekRafRef.current = null;
      }
      cancelPendingPreviewLoads();
    };
  }, [cancelPendingPreviewLoads]);

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
      updatePreviewFrameDebounced(next);
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
      const available = await pathExists(path);
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
      const info: PathMetadata = await getPathMetadata(path);
      return `${path}::${info.size}::${info.modified_ms}`;
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
      const dirAvailable = await pathExists(lastOutputDir);
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
    clearPreviewFrameErrors();
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
    pendingPreviewSeekRef.current = 0;
    const preferredStrategy = getPreferredPreviewStrategy(path);
    setClipPlaybackState(false);
    setPreviewPlaying(false);
    setPreviewStrategy(preferredStrategy);
    preparePreviewFramesForVideoLoad(preferredStrategy);
    setPreviewReady(false);

    const cacheKey = await buildVideoCacheKey(path);
    if (loadRequestIdRef.current !== loadRequestId) return;

    setVideoPath(path);
    setVideoCacheKey(cacheKey);
    setVideoInfo(null);
    clearTimelineFrames();
    setCurrentPreviewTime(0);
    setProgress(0);
    try {
      const info: VideoInfo = await getVideoInfo(path);
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
      resetPreviewFramesAfterVideoLoadFailure();
      setCurrentPreviewTime(0);
      toast.error("获取视频信息失败: " + e);
    }
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
      await cutVideo({
        precise: preciseMode,
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
    await cancelVideoCut();
    setProcessing(false);
    setProgress(0);
  }

  const {
    clipDuration,
    timelineFrameTargetCount,
    currentPreviewFrameNumber,
    startFrameNumber,
    endFrameNumber,
    clipFrameCount,
    currentPreviewInClip,
    offsetFromStart,
    offsetToEnd,
    clipProgressPercent,
    previewClipStatus,
    currentPreviewIndicatorPercent,
    hoverTimelineIndicatorPercent,
    hoverTimelineFrameNumber,
    showHoverTimelineIndicator,
    timelineStartPercent,
    timelineEndPercent,
    timelineStartIndicatorPercent,
    timelineEndIndicatorPercent,
    controlUnavailableReason,
    controlUnavailableBadge,
    exportUnavailableReason,
    primaryActionLabel,
    playClipButtonLabel,
    loopClipButtonLabel,
    snapPreviewButtonLabel,
    playClipButtonTitle,
    loopClipButtonTitle,
    snapPreviewButtonTitle,
    timelineStatusLabel,
  } = getVideoCutViewState({
    videoInfo,
    startTime,
    endTime,
    currentPreviewTime,
    hoverTimelineTime,
    timelineWidth,
    timelineDragMode,
    processing,
    previewStrategy,
    previewReady,
    clipPlaybackActive,
  });

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
                <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-[8px] border border-slate-200 bg-slate-50 text-[var(--brand-700)]">
                  <Icon name={dragging ? "folderOpen" : "video"} size={30} />
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
            <VideoCutPreviewTimeline
              videoPath={videoPath}
              videoInfo={videoInfo}
              previewStrategy={previewStrategy}
              previewFrame={previewFrame}
              timelineFrames={timelineFrames}
              loadingPreview={loadingPreview}
              loadingTimelineFrames={loadingTimelineFrames}
              previewFrameError={previewFrameError}
              timelineFramesError={timelineFramesError}
              processing={processing}
              preciseMode={preciseMode}
              previewReady={previewReady}
              clipPlaybackActive={clipPlaybackActive}
              loopClipPlayback={loopClipPlayback}
              showAdvancedControls={showAdvancedControls}
              currentPreviewTime={currentPreviewTime}
              startTime={startTime}
              endTime={endTime}
              clipDuration={clipDuration}
              timelineFrameTargetCount={timelineFrameTargetCount}
              currentPreviewFrameNumber={currentPreviewFrameNumber}
              startFrameNumber={startFrameNumber}
              endFrameNumber={endFrameNumber}
              currentPreviewInClip={currentPreviewInClip}
              timelineStartPercent={timelineStartPercent}
              timelineEndPercent={timelineEndPercent}
              timelineStartIndicatorPercent={timelineStartIndicatorPercent}
              timelineEndIndicatorPercent={timelineEndIndicatorPercent}
              currentPreviewIndicatorPercent={currentPreviewIndicatorPercent}
              hoverTimelineTime={hoverTimelineTime}
              hoverTimelineIndicatorPercent={hoverTimelineIndicatorPercent}
              hoverTimelineFrameNumber={hoverTimelineFrameNumber}
              showHoverTimelineIndicator={showHoverTimelineIndicator}
              timelineDragMode={timelineDragMode}
              controlUnavailableReason={controlUnavailableReason}
              controlUnavailableBadge={controlUnavailableBadge}
              playClipButtonLabel={playClipButtonLabel}
              loopClipButtonLabel={loopClipButtonLabel}
              snapPreviewButtonLabel={snapPreviewButtonLabel}
              playClipButtonTitle={playClipButtonTitle}
              loopClipButtonTitle={loopClipButtonTitle}
              snapPreviewButtonTitle={snapPreviewButtonTitle}
              timelineStatusLabel={timelineStatusLabel}
              timelineRef={timelineRef}
              previewVideoRef={previewVideoRef}
              onSelectVideo={selectVideo}
              onPreviewLoadedMetadata={handlePreviewLoadedMetadata}
              onPreviewTimeUpdate={handlePreviewTimeUpdate}
              onPreviewPlay={handlePreviewPlay}
              onPreviewPause={handlePreviewPause}
              onPreviewError={handlePreviewError}
              onRetryStaticPreview={retryStaticPreview}
              onRetryTimelineFrames={retryTimelineFrames}
              onToggleClipPlayback={() => void toggleClipPlayback()}
              onLoopClipPlaybackChange={setLoopClipPlayback}
              onStepPreviewFrame={stepPreviewFrame}
              onApplyCurrentFrameToStart={applyCurrentFrameToStart}
              onApplyCurrentFrameToEnd={applyCurrentFrameToEnd}
              onPreviewTimeChange={syncPreviewTime}
              onSnapPreviewIntoClip={snapPreviewIntoClip}
              onPreviewClipMiddle={previewClipMiddle}
              onShiftClipRange={shiftClipRange}
              onTimelinePointerDown={handleTimelinePointerDown}
              onTimelinePointerMove={handleTimelinePointerMove}
              onTimelinePointerLeave={handleTimelinePointerLeave}
              onTimelineWheel={handleTimelineWheel}
              onTimelineHandlePointerDown={handleTimelineHandlePointerDown}
            />

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

                <div className="rounded-[10px] border border-slate-200 bg-slate-50 px-4 py-3">
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

                <div className="rounded-[10px] border border-slate-200 bg-slate-50 px-4 py-3">
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
                  <div className="space-y-2 rounded-[10px] border border-slate-200 bg-slate-50 px-4 py-3">
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
