import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { useTaskReporter } from "../components/TaskCenter";
import { useToast } from "../components/Toast";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Progress } from "../components/ui/progress";
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

function formatTime(seconds: number) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 10);
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}.${ms}`;
  }
  return `${m}:${s.toString().padStart(2, "0")}.${ms}`;
}

function parseTimeInput(value: string) {
  const parts = value.split(":").map((part) => parseFloat(part) || 0);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function getMinClipDuration(duration: number) {
  if (duration <= 0) return 0.1;
  return Math.min(0.1, duration);
}

export default function VideoCut({ active = true }: { active?: boolean }) {
  const [videoPath, setVideoPath] = useState("");
  const [videoInfo, setVideoInfo] = useState<VideoInfo | null>(null);
  const [startTime, setStartTime] = useState(0);
  const [endTime, setEndTime] = useState(0);
  const [processing, setProcessing] = useState(false);
  const [preciseMode, setPreciseMode] = useState(false);
  const [previewFrame, setPreviewFrame] = useState("");
  const [timelineFrames, setTimelineFrames] = useState<string[]>([]);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [currentPreviewTime, setCurrentPreviewTime] = useState(0);
  const previewTimeoutRef = useRef<number | null>(null);
  const loadRequestIdRef = useRef(0);
  const previewRequestIdRef = useRef(0);
  const timelineRequestIdRef = useRef(0);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const [timelineDragMode, setTimelineDragMode] = useState<TimelineDragMode | null>(null);
  const videoInfoRef = useRef<VideoInfo | null>(null);
  const videoPathRef = useRef("");
  const startTimeRef = useRef(0);
  const endTimeRef = useRef(0);
  const [startTimeInput, setStartTimeInput] = useState("");
  const [endTimeInput, setEndTimeInput] = useState("");
  const [editingStart, setEditingStart] = useState(false);
  const [editingEnd, setEditingEnd] = useState(false);
  const [progress, setProgress] = useState(0);
  const toast = useToast();
  const task = useTaskReporter("video-cut");
  videoInfoRef.current = videoInfo;
  videoPathRef.current = videoPath;
  startTimeRef.current = startTime;
  endTimeRef.current = endTime;
  const { dragging } = useWindowDrop({
    active,
    onDrop: (paths) => {
      const file = paths[0];
      const ext = getExtension(file).toLowerCase();
      if (["mp4", "mov", "avi", "mkv", "wmv", "flv", "webm"].includes(ext)) {
        void loadVideo(file);
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
    if (!processing) {
      task.clearTask();
      return;
    }

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
      clearPendingPreviewTimeout();
      loadRequestIdRef.current += 1;
      previewRequestIdRef.current += 1;
      timelineRequestIdRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!timelineDragMode) return;

    const activeDragMode = timelineDragMode;

    function handlePointerMove(event: PointerEvent) {
      updateTimelineDrag(activeDragMode, event.clientX, false);
    }

    function handlePointerUp(event: PointerEvent) {
      updateTimelineDrag(activeDragMode, event.clientX, true);
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
    if (previewTimeoutRef.current) {
      window.clearTimeout(previewTimeoutRef.current);
      previewTimeoutRef.current = null;
    }
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

  function updateTimelineDrag(mode: TimelineDragMode, clientX: number, finalize: boolean) {
    const info = videoInfoRef.current;
    const path = videoPathRef.current;
    if (!info || !path) return;

    const rawTime = getTimelineTimeFromClientX(clientX);
    const minDuration = getMinClipDuration(info.duration);

    if (mode === "start") {
      const next = clamp(rawTime, 0, Math.max(0, endTimeRef.current - minDuration));
      startTimeRef.current = next;
      setStartTime(next);
      endTimeRef.current = Math.max(endTimeRef.current, next);
      setCurrentPreviewTime(next);
      if (finalize) {
        clearPendingPreviewTimeout();
        void loadPreviewFrame(path, next);
      } else {
        updatePreviewDebounced(next);
      }
      return;
    }

    if (mode === "end") {
      const next = clamp(rawTime, Math.min(info.duration, startTimeRef.current + minDuration), info.duration);
      endTimeRef.current = next;
      setEndTime(next);
      setCurrentPreviewTime(next);
      if (finalize) {
        clearPendingPreviewTimeout();
        void loadPreviewFrame(path, next);
      } else {
        updatePreviewDebounced(next);
      }
      return;
    }

    const next = clamp(rawTime, 0, info.duration);
    setCurrentPreviewTime(next);
    if (finalize) {
      clearPendingPreviewTimeout();
      void loadPreviewFrame(path, next);
    } else {
      updatePreviewDebounced(next);
    }
  }

  function beginTimelineDrag(mode: TimelineDragMode, clientX: number) {
    clearPendingPreviewTimeout();
    setTimelineDragMode(mode);
    updateTimelineDrag(mode, clientX, false);
  }

  function applyCurrentFrameToStart() {
    startTimeRef.current = currentPreviewTime;
    setStartTime(currentPreviewTime);
    if (currentPreviewTime > endTime) {
      endTimeRef.current = currentPreviewTime;
      setEndTime(currentPreviewTime);
    }
  }

  function applyCurrentFrameToEnd() {
    endTimeRef.current = currentPreviewTime;
    setEndTime(currentPreviewTime);
    if (currentPreviewTime < startTime) {
      startTimeRef.current = currentPreviewTime;
      setStartTime(currentPreviewTime);
    }
  }

  function handleTimelinePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!videoInfo) return;
    beginTimelineDrag("playhead", event.clientX);
  }

  function handleTimelineHandlePointerDown(mode: TimelineDragMode, event: ReactPointerEvent<HTMLButtonElement>) {
    event.stopPropagation();
    beginTimelineDrag(mode, event.clientX);
  }

  async function loadVideo(path: string) {
    const loadRequestId = ++loadRequestIdRef.current;
    previewRequestIdRef.current += 1;
    timelineRequestIdRef.current += 1;
    clearPendingPreviewTimeout();

    setVideoPath(path);
    setVideoInfo(null);
    setPreviewFrame("");
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
      await loadPreviewFrame(path, 0);
      if (loadRequestIdRef.current !== loadRequestId) return;
      void loadTimelineFrames(path);
    } catch (e) {
      if (loadRequestIdRef.current !== loadRequestId) return;
      setVideoPath("");
      setVideoInfo(null);
      setPreviewFrame("");
      setTimelineFrames([]);
      setCurrentPreviewTime(0);
      toast.error("获取视频信息失败: " + e);
    }
  }

  async function loadPreviewFrame(path: string, time: number) {
    const requestId = ++previewRequestIdRef.current;
    setLoadingPreview(true);
    try {
      const frame = await invoke<string>("generate_preview_frame", { path, time });
      if (previewRequestIdRef.current !== requestId) return;
      setPreviewFrame(frame);
      setCurrentPreviewTime(time);
    } catch (e) {
      if (previewRequestIdRef.current !== requestId) return;
      console.error("生成预览帧失败:", e);
    } finally {
      if (previewRequestIdRef.current === requestId) {
        setLoadingPreview(false);
      }
    }
  }

  async function loadTimelineFrames(path: string) {
    const requestId = ++timelineRequestIdRef.current;
    try {
      const frames = await invoke<string[]>("generate_timeline_frames", { path, count: 8 });
      if (timelineRequestIdRef.current !== requestId) return;
      setTimelineFrames(frames);
    } catch (e) {
      if (timelineRequestIdRef.current !== requestId) return;
      console.error("生成时间轴失败:", e);
    }
  }

  function updatePreviewDebounced(time: number) {
    clearPendingPreviewTimeout();
    previewTimeoutRef.current = window.setTimeout(() => {
      previewTimeoutRef.current = null;
      if (videoPath) {
        void loadPreviewFrame(videoPath, time);
      }
    }, 240);
  }

  async function selectVideo() {
    const file = await open({
      title: "选择视频文件",
      filters: [{ name: "视频文件", extensions: ["mp4", "mov", "avi", "mkv", "wmv", "flv", "webm"] }],
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

    const ext = getExtension(currentVideoPath) || "mp4";
    const baseName = stripExtension(getBaseName(currentVideoPath)) || "video";
    const outputPath = await save({
      title: "保存截取的视频",
      defaultPath: `${baseName}-${Date.now()}.${ext}`,
      filters: [{ name: "视频文件", extensions: [ext, "mp4"] }],
    });
    if (!outputPath) return;

    setProcessing(true);
    setProgress(0);
    try {
      const command = preciseMode ? "cut_video_precise" : "cut_video";
      await invoke(command, {
        input: currentVideoPath,
        output: outputPath,
        startTime: currentStartTime,
        endTime: currentEndTime,
      });
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
  const timelineStartPercent = videoInfo ? (startTime / videoInfo.duration) * 100 : 0;
  const timelineEndPercent = videoInfo ? (endTime / videoInfo.duration) * 100 : 0;

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
                  <Button variant="secondary" size="sm" onClick={selectVideo}>
                    更换视频
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="overflow-hidden rounded-[24px] bg-slate-950">
                  <div className="relative flex min-h-[360px] items-center justify-center px-4 py-4">
                    {previewFrame ? (
                      <img src={previewFrame} alt="视频预览" className="max-h-[420px] w-full object-contain" />
                    ) : (
                      <div className="text-sm text-slate-400">{loadingPreview ? "加载预览中…" : "等待生成预览"}</div>
                    )}
                    <div className="absolute bottom-4 left-4 rounded-full bg-slate-950/80 px-3 py-1 text-xs font-medium text-white">
                      {formatTime(currentPreviewTime)}
                    </div>
                    {loadingPreview && previewFrame && (
                      <div className="absolute right-4 top-4 rounded-full bg-slate-950/72 px-3 py-1 text-xs text-white">
                        更新中…
                      </div>
                    )}
                  </div>

                  {timelineFrames.length > 0 && videoInfo && (
                    <div className="border-t border-white/10 px-3 py-3">
                      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                        <div className="text-[11px] text-slate-400">缩略帧</div>
                        <div className="flex flex-wrap items-center gap-2">
                          <Button variant="ghost" size="sm" className="h-7 px-2.5 text-[11px]" onClick={applyCurrentFrameToStart}>
                            设起点
                          </Button>
                          <Button variant="ghost" size="sm" className="h-7 px-2.5 text-[11px]" onClick={applyCurrentFrameToEnd}>
                            设终点
                          </Button>
                        </div>
                      </div>
                      <div className="flex gap-2 overflow-x-auto pb-1">
                        {timelineFrames.map((frame, index) => {
                          const frameTime = (videoInfo.duration / (timelineFrames.length + 1)) * (index + 1);
                          const activeFrame = Math.abs(frameTime - currentPreviewTime) <= videoInfo.duration / (timelineFrames.length + 1) / 2;
                          return (
                            <button
                              key={index}
                              className={cn(
                                "group min-w-[92px] overflow-hidden rounded-xl border bg-slate-900/70 text-left transition",
                                activeFrame ? "border-amber-300/80 ring-1 ring-amber-300/40" : "border-white/10 hover:border-white/20"
                              )}
                              onClick={() => {
                                clearPendingPreviewTimeout();
                                setCurrentPreviewTime(frameTime);
                                void loadPreviewFrame(videoPath, frameTime);
                              }}
                            >
                              <img src={frame} alt="" className="h-12 w-full object-cover transition group-hover:opacity-100" />
                              <div className="px-2 py-1 text-[10px] text-slate-300">{formatTime(frameTime)}</div>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  <div className="border-t border-white/10 px-3 py-3">
                    <div className="mb-2 flex items-center justify-between text-[11px] text-slate-400">
                      <span>拖动两端调整范围，点击时间轴切换预览帧。</span>
                      <span>{formatTime(startTime)} - {formatTime(endTime)}</span>
                    </div>
                    <div
                      ref={timelineRef}
                      className="relative h-14 overflow-hidden rounded-2xl border border-white/10 bg-[linear-gradient(180deg,rgba(15,23,42,0.82),rgba(30,41,59,0.92))] select-none touch-none"
                      onPointerDown={handleTimelinePointerDown}
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

                      <button
                        className="absolute inset-y-0 z-20 w-6 -translate-x-1/2 cursor-ew-resize"
                        style={{ left: `${timelineStartPercent}%` }}
                        onPointerDown={(event) => handleTimelineHandlePointerDown("start", event)}
                        aria-label="调整开始时间"
                      >
                        <span className="absolute left-1/2 top-1 h-4 w-2 -translate-x-1/2 bg-[var(--brand-500)] [clip-path:polygon(50%_100%,0_0,100%_0)] drop-shadow-[0_4px_8px_rgba(15,23,42,0.28)]" />
                      </button>
                      <button
                        className="absolute inset-y-0 z-20 w-6 -translate-x-1/2 cursor-ew-resize"
                        style={{ left: `${timelineEndPercent}%` }}
                        onPointerDown={(event) => handleTimelineHandlePointerDown("end", event)}
                        aria-label="调整结束时间"
                      >
                        <span className="absolute left-1/2 top-1 h-4 w-2 -translate-x-1/2 bg-rose-400 [clip-path:polygon(50%_100%,0_0,100%_0)] drop-shadow-[0_4px_8px_rgba(15,23,42,0.28)]" />
                      </button>
                    </div>
                    <div className="mt-2 grid grid-cols-3 text-[11px] text-slate-400">
                      <span>开始 {formatTime(startTime)}</span>
                      <span className="text-center">片段 {formatTime(clipDuration)}</span>
                      <span className="text-right">结束 {formatTime(endTime)}</span>
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
                        onFocus={() => {
                          setEditingStart(true);
                          setStartTimeInput(formatTime(startTime));
                        }}
                        onChange={(event) => setStartTimeInput(event.target.value)}
                        onBlur={() => {
                          setEditingStart(false);
                        const time = parseTimeInput(startTimeInput);
                        if (time >= 0 && time <= (videoInfo?.duration || 0)) {
                          clearPendingPreviewTimeout();
                          startTimeRef.current = time;
                          setStartTime(time);
                          if (time > endTime) setEndTime(time);
                          if (time > endTimeRef.current) endTimeRef.current = time;
                          void loadPreviewFrame(videoPath, time);
                        }
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") (event.target as HTMLInputElement).blur();
                        }}
                        className="font-mono"
                      />
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
                        onFocus={() => {
                          setEditingEnd(true);
                          setEndTimeInput(formatTime(endTime));
                        }}
                        onChange={(event) => setEndTimeInput(event.target.value)}
                        onBlur={() => {
                          setEditingEnd(false);
                        const time = parseTimeInput(endTimeInput);
                        if (time >= 0 && time <= (videoInfo?.duration || 0)) {
                          clearPendingPreviewTimeout();
                          endTimeRef.current = time;
                          setEndTime(time);
                          if (time < startTime) setStartTime(time);
                          if (time < startTimeRef.current) startTimeRef.current = time;
                          void loadPreviewFrame(videoPath, time);
                        }
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") (event.target as HTMLInputElement).blur();
                        }}
                        className="font-mono"
                      />
                    </div>
                  </div>

                  {videoInfo && (
                    <div className="text-xs text-slate-400">
                      拖动时间轴左手柄调整开始，右手柄调整结束。
                    </div>
                  )}
                </div>

                <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                  <label className="flex items-center gap-3 text-sm text-slate-600">
                    <input
                      type="checkbox"
                      checked={preciseMode}
                      onChange={(event) => setPreciseMode(event.target.checked)}
                      className="h-4 w-4 rounded"
                    />
                    <span>
                      <span className="font-medium text-slate-800">精确模式</span>
                      <span className="ml-2 text-slate-500">更慢，但起止点更准。</span>
                    </span>
                  </label>
                </div>

                {processing && preciseMode && (
                  <div className="space-y-2 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-slate-800">正在编码</span>
                      <span className="font-mono text-[var(--brand-600)]">{progress.toFixed(1)}%</span>
                    </div>
                    <Progress value={progress} />
                  </div>
                )}

                <div className="space-y-3 border-t border-slate-100 pt-4">
                  <Button variant="primary" className="w-full" onClick={handleCut} disabled={processing || clipDuration <= 0}>
                    {processing ? "处理中…" : "开始截取"}
                  </Button>
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
