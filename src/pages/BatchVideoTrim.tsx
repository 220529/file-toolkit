import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useTaskReporter } from "../components/TaskCenter";
import { useToast } from "../components/Toast";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { EmptyState } from "../components/ui/empty-state";
import { Input } from "../components/ui/input";
import { Progress } from "../components/ui/progress";
import { Switch } from "../components/ui/switch";
import { useFileActions } from "../hooks/useFileActions";
import { useWindowDrop } from "../hooks/useWindowDrop";
import { cn } from "../utils/cn";
import { getBaseName } from "../utils/path";
import { safeListen } from "../utils/tauriEvent";
import { formatSize } from "../utils/format";

interface BatchVideoFile {
  path: string;
  name: string;
  size: number;
}

interface VideoInfo {
  duration: number;
  width: number;
  height: number;
  fps: number;
}

interface BatchTrimProgress {
  task_id: string;
  stage: string;
  current: number;
  total: number;
  percent: number;
  current_file: string;
  item_progress: number;
  succeeded: number;
  skipped: number;
  failed: number;
}

interface BatchTrimItemResult {
  input_path: string;
  output_path: string | null;
  status: "success" | "skipped" | "failed";
  message: string;
}

interface BatchTrimResult {
  total: number;
  succeeded: number;
  skipped: number;
  failed: number;
  items: BatchTrimItemResult[];
}

type OutputMode = "source" | "directory";
type PreviewStrategy = "video" | "image";

const SUPPORTED_VIDEO_EXTENSIONS = ["mp4", "mov", "avi", "mkv", "wmv", "flv", "webm"];
const BATCH_OUTPUT_DIR_STORAGE_KEY = "batch-video-trim-output-dir";

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

function getFrameDuration(fps: number) {
  if (!Number.isFinite(fps) || fps <= 0) return 1 / 30;
  return 1 / clamp(fps, 1, 120);
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

function getPreferredPreviewStrategy(path: string): PreviewStrategy {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  return ["mp4", "mov", "webm"].includes(ext) ? "video" : "image";
}

function getProgressText(progress: BatchTrimProgress | null) {
  if (!progress) return "等待开始";
  const segments = [
    `第 ${Math.max(0, Math.min(progress.current, progress.total))}/${progress.total || 0} 个`,
    `${progress.succeeded} 成功`,
  ];
  if (progress.skipped > 0) segments.push(`${progress.skipped} 跳过`);
  if (progress.failed > 0) segments.push(`${progress.failed} 失败`);
  if (progress.current_file) segments.push(progress.current_file);
  return segments.join(" · ");
}

export default function BatchVideoTrim({ active = true }: { active?: boolean }) {
  const [files, setFiles] = useState<BatchVideoFile[]>([]);
  const [samplePath, setSamplePath] = useState("");
  const [sampleInfo, setSampleInfo] = useState<VideoInfo | null>(null);
  const [currentPreviewTime, setCurrentPreviewTime] = useState(0);
  const [trimTime, setTrimTime] = useState(0);
  const [trimInput, setTrimInput] = useState("");
  const [editingTrim, setEditingTrim] = useState(false);
  const [previewStrategy, setPreviewStrategy] = useState<PreviewStrategy>("video");
  const [previewReady, setPreviewReady] = useState(false);
  const [previewFrame, setPreviewFrame] = useState("");
  const [loadingSample, setLoadingSample] = useState(false);
  const [timelineFrames, setTimelineFrames] = useState<string[]>([]);
  const [loadingTimeline, setLoadingTimeline] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState<BatchTrimProgress | null>(null);
  const [result, setResult] = useState<BatchTrimResult | null>(null);
  const [preciseMode, setPreciseMode] = useState(false);
  const [outputMode, setOutputMode] = useState<OutputMode>("source");
  const [outputDir, setOutputDir] = useState("");
  const [suffix, setSuffix] = useState("_trim");
  const [previewFrameError, setPreviewFrameError] = useState(false);
  const [reviewedSamples, setReviewedSamples] = useState<Set<string>>(new Set());
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  const currentTaskIdRef = useRef<string | null>(null);
  const sampleLoadRequestIdRef = useRef(0);
  const previewFrameRequestIdRef = useRef(0);
  const task = useTaskReporter("batch-video-trim");
  const toast = useToast();
  const fileActions = useFileActions();

  const { dragging } = useWindowDrop({
    active: active && !processing,
    onDrop: (paths) => {
      void appendInputs(paths);
    },
  });

  const sampleVideoSrc = samplePath ? convertFileSrc(samplePath) : "";
  const totalSize = files.reduce((sum, item) => sum + item.size, 0);
  const sampleIndex = files.findIndex((item) => item.path === samplePath);
  const firstSuccessOutput = result?.items.find((item) => item.status === "success" && item.output_path)?.output_path ?? "";
  const reviewedCount = Array.from(reviewedSamples).filter((path) => files.some((item) => item.path === path)).length;
  const sampleKeptDuration = sampleInfo ? Math.max(0, sampleInfo.duration - trimTime) : 0;

  useEffect(() => {
    try {
      const storedOutputDir = window.localStorage.getItem(BATCH_OUTPUT_DIR_STORAGE_KEY);
      if (storedOutputDir) {
        setOutputDir(storedOutputDir);
      }
    } catch (error) {
      console.error("读取批量去头输出目录失败:", error);
    }
  }, []);

  useEffect(() => {
    if (!active) return;

    return safeListen<BatchTrimProgress>("batch-video-progress", (event) => {
      if (event.payload.task_id !== currentTaskIdRef.current) return;
      setProgress((prev) => {
        if (
          prev &&
          prev.task_id === event.payload.task_id &&
          prev.stage === event.payload.stage &&
          event.payload.percent < prev.percent
        ) {
          return prev;
        }
        return event.payload;
      });
    });
  }, [active]);

  useEffect(() => {
    if (!processing) {
      task.clearTask();
      return;
    }

    task.reportTask({
      title: "批量去片头",
      stage: progress?.stage || "处理中",
      detail: getProgressText(progress),
      progress: progress?.percent,
      cancellable: true,
      onCancel: cancelBatchTrim,
    });
  }, [processing, progress]);

  useEffect(() => {
    if (!files.length) {
      setSamplePath("");
      setSampleInfo(null);
      setCurrentPreviewTime(0);
      setTrimTime(0);
      setTimelineFrames([]);
      setReviewedSamples(new Set());
      return;
    }

    if (!files.some((item) => item.path === samplePath)) {
      setSamplePath(files[0].path);
    }
  }, [files, samplePath]);

  useEffect(() => {
    if (!samplePath || !active) return;
    void loadSample(samplePath);
  }, [samplePath, active]);

  useEffect(() => {
    if (previewStrategy !== "image" || !samplePath) return;
    void loadPreviewFrame(samplePath, currentPreviewTime);
  }, [previewStrategy, samplePath, currentPreviewTime]);

  async function appendInputs(paths: string[]) {
    if (processing) {
      toast.info("当前正在处理，暂时无法更换素材");
      return;
    }

    if (!paths.length) return;

    try {
      const incoming = await invoke<BatchVideoFile[]>("collect_batch_video_files", { inputs: paths });
      if (incoming.length === 0) {
        toast.warning("没有发现可处理的视频文件");
        return;
      }

      let addedCount = 0;
      setFiles((current) => {
        const map = new Map(current.map((item) => [item.path, item]));
        incoming.forEach((item) => {
          if (!map.has(item.path)) addedCount += 1;
          map.set(item.path, item);
        });
        return Array.from(map.values()).sort((a, b) => a.path.localeCompare(b.path));
      });
      setResult(null);
      if (!samplePath) {
        setSamplePath(incoming[0].path);
      }
      toast.success(addedCount > 0 ? `已加入 ${addedCount} 个视频` : `已更新 ${incoming.length} 个视频`);
    } catch (error) {
      console.error(error);
      toast.error("载入素材失败: " + error);
    }
  }

  async function selectFiles() {
    const selected = await open({
      title: "选择视频文件",
      multiple: true,
      filters: [{ name: "视频文件", extensions: SUPPORTED_VIDEO_EXTENSIONS }],
    });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    await appendInputs(paths.filter((value): value is string => typeof value === "string"));
  }

  async function selectFolder() {
    const selected = await open({ title: "选择视频文件夹", directory: true });
    if (typeof selected === "string") {
      await appendInputs([selected]);
    }
  }

  async function chooseOutputDirectory() {
    const selected = await open({ title: "选择输出目录", directory: true });
    if (typeof selected === "string") {
      setOutputDir(selected);
      try {
        window.localStorage.setItem(BATCH_OUTPUT_DIR_STORAGE_KEY, selected);
      } catch (error) {
        console.error("保存批量去头输出目录失败:", error);
      }
    }
  }

  function removeFile(path: string) {
    if (processing) return;
    setFiles((current) => current.filter((item) => item.path !== path));
    setResult(null);
  }

  function clearFiles() {
    if (processing) return;
    setFiles([]);
    setResult(null);
  }

  async function loadSample(path: string) {
    const requestId = ++sampleLoadRequestIdRef.current;
    setLoadingSample(true);
    setPreviewReady(false);
    setPreviewFrame("");
    setPreviewFrameError(false);
    setTimelineFrames([]);
    setLoadingTimeline(true);
    try {
      const info = await invoke<VideoInfo>("get_video_info", { path });
      if (sampleLoadRequestIdRef.current !== requestId) return;
      setSampleInfo(info);
      setReviewedSamples((current) => new Set(current).add(path));
      setPreviewStrategy(getPreferredPreviewStrategy(path));
      setTrimTime((current) => {
        const next = current > 0 ? Math.min(current, Math.max(0, info.duration - getFrameDuration(info.fps))) : 0;
        return next;
      });
      setCurrentPreviewTime((current) => clamp(current, 0, info.duration));
      try {
        const frames = await invoke<string[]>("generate_timeline_frames", { path, count: 10 });
        if (sampleLoadRequestIdRef.current !== requestId) return;
        setTimelineFrames(frames);
      } catch (error) {
        if (sampleLoadRequestIdRef.current !== requestId) return;
        console.error(error);
        setTimelineFrames([]);
      }
    } catch (error) {
      if (sampleLoadRequestIdRef.current !== requestId) return;
      console.error(error);
      toast.error("载入样本失败: " + error);
      setSampleInfo(null);
      setTimelineFrames([]);
    } finally {
      if (sampleLoadRequestIdRef.current !== requestId) return;
      setLoadingSample(false);
      setLoadingTimeline(false);
    }
  }

  async function loadPreviewFrame(path: string, time: number) {
    const requestId = ++previewFrameRequestIdRef.current;
    try {
      const frame = await invoke<string>("generate_preview_frame", { path, time });
      if (previewFrameRequestIdRef.current !== requestId) return;
      setPreviewFrame(frame);
      setPreviewFrameError(false);
    } catch (error) {
      if (previewFrameRequestIdRef.current !== requestId) return;
      console.error(error);
      setPreviewFrame("");
      setPreviewFrameError(true);
    }
  }

  function syncPreviewTime(nextTime: number) {
    const next = clamp(nextTime, 0, sampleInfo?.duration ?? nextTime);
    setCurrentPreviewTime(next);
    const video = previewVideoRef.current;
    if (previewStrategy === "video" && video && Math.abs(video.currentTime - next) > 0.001) {
      video.currentTime = next;
    }
  }

  function stepFrame(direction: -1 | 1) {
    if (!sampleInfo) return;
    const frameDuration = getFrameDuration(sampleInfo.fps);
    const strategy = direction < 0 ? "floor" : "ceil";
    syncPreviewTime(snapTimeToFrame(currentPreviewTime + direction * frameDuration, sampleInfo, strategy));
  }

  function setTrimToCurrentFrame() {
    if (!sampleInfo) return;
    const snapped = snapTimeToFrame(currentPreviewTime, sampleInfo, "floor");
    setTrimTime(snapped);
    setTrimInput(formatTime(snapped));
  }

  function jumpToTrimPoint() {
    syncPreviewTime(trimTime);
  }

  function resetTrimPoint() {
    setTrimTime(0);
    setTrimInput(formatTime(0));
    syncPreviewTime(0);
  }

  function handlePreviewLoadedMetadata(event: SyntheticEvent<HTMLVideoElement>) {
    setPreviewReady(true);
    event.currentTarget.currentTime = currentPreviewTime;
  }

  function handlePreviewTimeUpdate(event: SyntheticEvent<HTMLVideoElement>) {
    setCurrentPreviewTime(snapTimeToFrame(event.currentTarget.currentTime, sampleInfo));
  }

  function handlePreviewError() {
    if (!samplePath) return;
    setPreviewStrategy("image");
    setPreviewReady(false);
    void loadPreviewFrame(samplePath, currentPreviewTime);
  }

  function selectPreviousSample() {
    if (!files.length || sampleIndex <= 0) return;
    setSamplePath(files[sampleIndex - 1].path);
  }

  function selectNextSample() {
    if (!files.length || sampleIndex < 0 || sampleIndex >= files.length - 1) return;
    setSamplePath(files[sampleIndex + 1].path);
  }

  function selectRandomSample() {
    if (files.length <= 1) return;
    const candidates = files.filter((item) => item.path !== samplePath);
    const next = candidates[Math.floor(Math.random() * candidates.length)];
    if (next) {
      setSamplePath(next.path);
    }
  }

  async function handleBatchTrim() {
    if (!files.length) {
      toast.error("请先添加视频素材");
      return;
    }
    if (trimTime <= 0) {
      toast.error("请先设定片头结束时间");
      return;
    }
    if (outputMode === "directory" && !outputDir) {
      toast.error("请先选择输出目录");
      return;
    }

    const taskId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    currentTaskIdRef.current = taskId;
    setProcessing(true);
    setProgress({
      task_id: taskId,
      stage: "准备批量去片头",
      current: 0,
      total: files.length,
      percent: 0,
      current_file: "",
      item_progress: 0,
      succeeded: 0,
      skipped: 0,
      failed: 0,
    });
    setResult(null);

    try {
      const response = await invoke<BatchTrimResult>("batch_trim_videos", {
        taskId,
        paths: files.map((item) => item.path),
        trimStart: trimTime,
        preciseMode,
        outputMode,
        outputDir: outputMode === "directory" ? outputDir : null,
        suffix,
      });
      if (currentTaskIdRef.current !== taskId) return;
      setResult(response);
      if (outputMode === "directory" && outputDir) {
        try {
          window.localStorage.setItem(BATCH_OUTPUT_DIR_STORAGE_KEY, outputDir);
        } catch (error) {
          console.error("保存批量去头输出目录失败:", error);
        }
      }
      toast.success(
        `处理完成：${response.succeeded} 成功${response.skipped > 0 ? `，${response.skipped} 跳过` : ""}${response.failed > 0 ? `，${response.failed} 失败` : ""}`
      );
    } catch (error) {
      if (currentTaskIdRef.current !== taskId) return;
      console.error(error);
      const message = String(error);
      if (message.includes("取消")) {
        toast.info("已取消批量处理");
      } else {
        toast.error("批量处理失败: " + error);
      }
    } finally {
      if (currentTaskIdRef.current !== taskId) return;
      setProcessing(false);
      setProgress(null);
    }
  }

  async function cancelBatchTrim() {
    const taskId = currentTaskIdRef.current;
    if (!taskId) return;
    try {
      await invoke("cancel_batch_video_trim", { taskId });
      currentTaskIdRef.current = null;
      setProcessing(false);
      setProgress(null);
      toast.info("已取消批量处理");
    } catch (error) {
      console.error(error);
      toast.error("取消失败: " + error);
    }
  }

  return (
    <div className="space-y-6 p-6">
      <Card className="overflow-hidden">
        <CardContent className="px-5 py-5">
          <div
            className={cn(
              "drop-zone flex flex-col items-center justify-center",
              dragging && "dragging",
              processing && "pointer-events-none opacity-70"
            )}
            onClick={() => void selectFiles()}
          >
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-[22px] bg-white text-3xl shadow-[0_16px_34px_rgba(15,23,42,0.08)]">
              {dragging ? "📂" : "🎞️"}
            </div>
            <div className="text-lg font-semibold text-slate-900">{dragging ? "松开以载入素材" : "拖入视频或文件夹，或点击选择视频"}</div>
            <div className="mt-2 text-sm text-slate-500">适合一批拥有相同片头的视频，统一删除前 X 秒。</div>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={(event) => {
                  event.stopPropagation();
                  void selectFiles();
                }}
                disabled={processing}
              >
                选择视频
              </Button>
              <Button variant="ghost" size="sm" onClick={(event) => {
                event.stopPropagation();
                void selectFolder();
              }} disabled={processing}>
                选择文件夹
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {files.length === 0 ? (
        <EmptyState
          icon="✂️"
          title="还没有待处理的视频"
          description="先导入一批素材，再在样本视频上设定片头结束点。"
        />
      ) : (
        <>
          <Card className="bg-[linear-gradient(135deg,rgba(255,255,255,0.96),rgba(245,248,255,0.92))]">
            <CardContent className="px-5 py-4">
              <div className="overflow-x-auto">
                <div className="flex min-w-max items-center gap-3 whitespace-nowrap text-sm text-slate-600">
                  <span className="text-xs font-medium uppercase tracking-[0.18em] text-slate-400">概览</span>
                  <span>
                    视频 <span className="font-semibold text-slate-900">{files.length.toLocaleString()}</span>
                  </span>
                  <span className="text-slate-300">/</span>
                  <span>
                    样本 <span className="font-semibold text-slate-900">{samplePath ? getBaseName(samplePath) : "--"}</span>
                  </span>
                  <span className="text-slate-300">/</span>
                  <span>
                    片头 <span className="font-semibold text-slate-900">{formatTime(trimTime)}</span>
                  </span>
                  <span className="text-slate-300">/</span>
                  <span>
                    总大小 <span className="font-semibold text-slate-900">{formatSize(totalSize)}</span>
                  </span>
                  <span className="text-slate-300">/</span>
                  <span>
                    已抽查 <span className="font-semibold text-slate-900">{reviewedCount.toLocaleString()}</span>
                  </span>
                </div>
              </div>
              <div className="mt-2 text-[11px] text-slate-400">默认不覆盖原文件；重名会自动追加编号，时长不足的视频会自动跳过。</div>
            </CardContent>
          </Card>

          <div className="grid gap-6 xl:grid-cols-[minmax(0,1.45fr)_380px]">
            <Card className="overflow-hidden">
              <CardHeader>
                <div>
                  <CardTitle>样本定点</CardTitle>
                  <div className="mt-1 text-sm text-slate-500">
                    只需要在一条样本上设定“片头结束点”，系统会应用到整批视频。
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone="default">样本 {sampleIndex >= 0 ? `${sampleIndex + 1}/${files.length}` : "--"}</Badge>
                  <Badge tone={reviewedCount >= 3 ? "success" : "default"}>抽查 {reviewedCount}</Badge>
                  <Button variant="ghost" size="sm" onClick={selectPreviousSample} disabled={processing || sampleIndex <= 0}>
                    上一条
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={selectNextSample}
                    disabled={processing || sampleIndex < 0 || sampleIndex >= files.length - 1}
                  >
                    下一条
                  </Button>
                  <Button variant="ghost" size="sm" onClick={selectRandomSample} disabled={processing || files.length <= 1}>
                    随机抽查
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="overflow-hidden rounded-[24px] bg-slate-950">
                  <div className="relative flex min-h-[320px] items-center justify-center px-4 py-4">
                    {previewStrategy === "video" && sampleVideoSrc ? (
                      <video
                        key={sampleVideoSrc}
                        ref={previewVideoRef}
                        src={sampleVideoSrc}
                        controls
                        playsInline
                        preload="metadata"
                        className="max-h-[400px] w-full object-contain"
                        onLoadedMetadata={handlePreviewLoadedMetadata}
                        onTimeUpdate={handlePreviewTimeUpdate}
                        onSeeked={handlePreviewTimeUpdate}
                        onError={handlePreviewError}
                      />
                    ) : previewFrame ? (
                      <img src={previewFrame} alt="样本预览" className="max-h-[400px] w-full object-contain" />
                    ) : (
                      <div className="text-sm text-slate-400">
                        {previewFrameError ? "预览生成失败" : loadingSample ? "加载样本中…" : "等待载入样本"}
                      </div>
                    )}
                    <div className="absolute bottom-4 left-4 rounded-full bg-slate-950/80 px-3 py-1 text-xs font-medium text-white">
                      当前帧 {formatTime(currentPreviewTime)}
                    </div>
                    {previewStrategy === "video" && !previewReady && sampleVideoSrc && (
                      <div className="absolute right-4 top-4 rounded-full bg-slate-950/72 px-3 py-1 text-xs text-white">
                        载入预览中…
                      </div>
                    )}
                    <div className="absolute bottom-4 right-4 rounded-full bg-[var(--brand-600)]/90 px-3 py-1 text-xs font-medium text-white">
                      片头结束 {formatTime(trimTime)}
                    </div>
                  </div>
                  <div className="border-t border-white/10 px-3 py-3">
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                      <div className="text-[11px] text-slate-400">
                        {timelineFrames.length > 0 ? `缩略帧 ${timelineFrames.length} 张` : "缩略帧"}
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button variant="ghost" size="sm" className="h-7 px-2.5 text-[11px]" onClick={() => stepFrame(-1)} disabled={processing || !sampleInfo}>
                          上一帧
                        </Button>
                        <Button variant="ghost" size="sm" className="h-7 px-2.5 text-[11px]" onClick={() => stepFrame(1)} disabled={processing || !sampleInfo}>
                          下一帧
                        </Button>
                        <Button variant="primary" size="sm" className="h-7 px-2.5 text-[11px]" onClick={setTrimToCurrentFrame} disabled={processing || !sampleInfo}>
                          设为片头结束
                        </Button>
                        <Button variant="ghost" size="sm" className="h-7 px-2.5 text-[11px]" onClick={jumpToTrimPoint} disabled={processing || !sampleInfo || trimTime <= 0}>
                          看片头点
                        </Button>
                        <Button variant="ghost" size="sm" className="h-7 px-2.5 text-[11px]" onClick={resetTrimPoint} disabled={processing || trimTime <= 0}>
                          重置为 0
                        </Button>
                      </div>
                    </div>
                    {timelineFrames.length > 0 ? (
                      <div className="flex gap-2 overflow-x-auto pb-1">
                        {timelineFrames.map((frame, index) => {
                          const frameTime = sampleInfo
                            ? snapTimeToFrame((sampleInfo.duration / (timelineFrames.length + 1)) * (index + 1), sampleInfo)
                            : 0;
                          return (
                            <button
                              key={`${samplePath}-${index}`}
                              className="min-w-[92px] overflow-hidden rounded-xl border border-white/10 bg-slate-900/70 text-left transition hover:border-white/20"
                              disabled={processing}
                              onClick={() => syncPreviewTime(frameTime)}
                              title={formatTime(frameTime)}
                            >
                              <img src={frame} alt="" className="h-12 w-full object-cover" />
                              <div className="px-2 py-1 text-[10px] text-slate-300">{formatTime(frameTime)}</div>
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="rounded-xl border border-dashed border-white/10 px-3 py-3 text-[11px] text-slate-400">
                        {loadingTimeline ? "缩略帧生成中…" : "暂时没有缩略帧，可直接用视频播放器定位。"}
                      </div>
                    )}
                  </div>
                </div>

                {sampleInfo && (
                  <div className="space-y-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                    <div className="flex h-2 overflow-hidden rounded-full bg-slate-200">
                      <div
                        className="bg-[linear-gradient(90deg,#2563eb,#3b82f6)]"
                        style={{ width: `${sampleInfo.duration > 0 ? (trimTime / sampleInfo.duration) * 100 : 0}%` }}
                      />
                    </div>
                    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
                    <div className="flex items-center gap-2">
                      <span className="text-slate-400">样本时长</span>
                      <span className="font-medium text-slate-900">{formatTime(sampleInfo.duration)}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-slate-400">画面规格</span>
                      <span className="font-medium text-slate-900">{sampleInfo.width}×{sampleInfo.height}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-slate-400">帧率</span>
                      <span className="font-medium text-slate-900">{sampleInfo.fps.toFixed(2).replace(/\.?0+$/, "")} fps</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-slate-400">删除前缀</span>
                      <span className="font-medium text-slate-900">{formatTime(trimTime)}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-slate-400">样本保留</span>
                      <span className="font-medium text-slate-900">{formatTime(sampleKeptDuration)}</span>
                    </div>
                    <div className="ml-auto text-[11px] text-slate-400">建议至少抽查 2 到 3 条样本后再开始批量处理。</div>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <div>
                  <CardTitle>批量设置</CardTitle>
                </div>
              </CardHeader>
              <CardContent className="space-y-5">
                <div>
                  <div className="mb-2 text-sm font-medium text-slate-800">片头结束时间</div>
                  <Input
                    value={editingTrim ? trimInput : formatTime(trimTime)}
                    placeholder="mm:ss.000"
                    onFocus={(event) => {
                      setEditingTrim(true);
                      setTrimInput(formatTime(trimTime));
                      window.requestAnimationFrame(() => event.currentTarget.select());
                    }}
                    onChange={(event) => setTrimInput(event.target.value)}
                    onBlur={() => {
                      setEditingTrim(false);
                      const parsed = parseTimeInput(trimInput);
                      if (parsed === null) {
                        toast.error("时间格式无效，请输入秒数或 mm:ss.ms / hh:mm:ss.ms");
                        return;
                      }
                      setTrimTime(sampleInfo ? clamp(parsed, 0, sampleInfo.duration) : Math.max(0, parsed));
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        (event.target as HTMLInputElement).blur();
                      }
                    }}
                    className="font-mono"
                    disabled={processing}
                  />
                  <div className="mt-2 text-[11px] text-slate-400">会统一删除每个视频开头的这段时间。</div>
                </div>

                <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                  <div className="text-sm font-medium text-slate-800">开始前确认</div>
                  <div className="mt-2 text-[11px] text-slate-500">
                    当前会对 <span className="font-medium text-slate-700">{files.length.toLocaleString()}</span> 个视频统一删除前{" "}
                    <span className="font-medium text-slate-700">{formatTime(trimTime)}</span>，输出到
                    <span className="font-medium text-slate-700">
                      {outputMode === "source" ? " 原目录" : outputDir ? ` ${outputDir}` : " 指定目录"}
                    </span>
                    ，文件名后缀为 <span className="font-medium text-slate-700">{suffix || "_trim"}</span>。
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
                </div>

                <div className="space-y-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                  <div className="text-sm font-medium text-slate-800">输出位置</div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant={outputMode === "source" ? "primary" : "secondary"}
                      size="sm"
                      onClick={() => setOutputMode("source")}
                      disabled={processing}
                    >
                      原目录
                    </Button>
                    <Button
                      variant={outputMode === "directory" ? "primary" : "secondary"}
                      size="sm"
                      onClick={() => setOutputMode("directory")}
                      disabled={processing}
                    >
                      指定目录
                    </Button>
                  </div>
                  {outputMode === "directory" && (
                    <div className="space-y-2">
                      <div className="truncate text-xs text-slate-500">{outputDir || "尚未选择输出目录"}</div>
                      <Button variant="ghost" size="sm" onClick={() => void chooseOutputDirectory()} disabled={processing}>
                        选择目录
                      </Button>
                    </div>
                  )}
                  <div>
                    <div className="mb-2 text-xs text-slate-500">文件名后缀</div>
                    <Input value={suffix} onChange={(event) => setSuffix(event.target.value)} disabled={processing} />
                  </div>
                </div>

                {processing && progress && (
                  <div className="space-y-2 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-slate-800">{progress.stage}</span>
                      <span className="font-mono text-[var(--brand-600)]">{progress.percent.toFixed(1)}%</span>
                    </div>
                    <Progress value={progress.percent} />
                    <div className="text-[11px] text-slate-400">{getProgressText(progress)}</div>
                  </div>
                )}

                <div className="space-y-3 border-t border-slate-100 pt-4">
                  <Button variant="primary" className="w-full" onClick={() => void handleBatchTrim()} disabled={processing || files.length === 0}>
                    {processing ? "处理中…" : "开始批量去片头"}
                  </Button>
                  {processing && (
                    <Button variant="danger" className="w-full" onClick={() => void cancelBatchTrim()}>
                      取消处理
                    </Button>
                  )}
                  <Button variant="ghost" className="w-full" onClick={clearFiles} disabled={processing || files.length === 0}>
                    清空素材
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
            <Card>
              <CardHeader>
                <div>
                  <CardTitle>素材列表</CardTitle>
                </div>
                <Badge tone="default">{files.length} 项</Badge>
              </CardHeader>
              <CardContent className="max-h-[420px] space-y-2 overflow-auto">
                {files.map((item) => {
                  const selected = item.path === samplePath;
                  return (
                    <div
                      key={item.path}
                      className={cn(
                        "flex items-center gap-3 rounded-2xl border px-3 py-3 transition",
                        selected ? "border-[var(--brand-300)] bg-[var(--brand-50)]" : "border-slate-200 bg-white"
                      )}
                    >
                      <button
                        className="min-w-0 flex-1 text-left"
                        onClick={() => setSamplePath(item.path)}
                        disabled={processing}
                      >
                        <div className="truncate text-sm font-medium text-slate-900">{item.name}</div>
                        <div className="truncate text-xs text-slate-500">{item.path}</div>
                      </button>
                      <div className="text-xs text-slate-400">{formatSize(item.size)}</div>
                      {selected && <Badge tone="info">样本</Badge>}
                      <Button variant="ghost" size="sm" onClick={() => removeFile(item.path)} disabled={processing}>
                        移除
                      </Button>
                    </div>
                  );
                })}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <div>
                  <CardTitle>处理结果</CardTitle>
                </div>
                {result && <Badge tone="default">{result.total} 项</Badge>}
              </CardHeader>
              <CardContent>
                {!result ? (
                  <div className="text-sm text-slate-500">处理完成后，这里会显示成功、跳过和失败明细。</div>
                ) : (
                  <div className="space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex min-w-max items-center gap-3 whitespace-nowrap text-sm text-slate-600">
                        <span>
                          成功 <span className="font-semibold text-slate-900">{result.succeeded}</span>
                        </span>
                        <span className="text-slate-300">/</span>
                        <span>
                          跳过 <span className="font-semibold text-slate-900">{result.skipped}</span>
                        </span>
                        <span className="text-slate-300">/</span>
                        <span>
                          失败 <span className="font-semibold text-slate-900">{result.failed}</span>
                        </span>
                      </div>
                      {firstSuccessOutput && (
                        <Button variant="ghost" size="sm" onClick={() => void fileActions.revealInDir(firstSuccessOutput)}>
                          打开首个输出位置
                        </Button>
                      )}
                    </div>
                    <div className="max-h-[360px] space-y-2 overflow-auto">
                      {result.items.map((item) => (
                        <div
                          key={`${item.input_path}-${item.status}`}
                          className={cn(
                            "rounded-2xl border px-3 py-3 text-sm",
                            item.status === "success"
                              ? "border-emerald-100 bg-emerald-50/60"
                              : item.status === "skipped"
                                ? "border-amber-100 bg-amber-50/60"
                                : "border-rose-100 bg-rose-50/60"
                          )}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div className="truncate font-medium text-slate-900">{getBaseName(item.input_path)}</div>
                            <Badge
                              tone={
                                item.status === "success"
                                  ? "success"
                                  : item.status === "skipped"
                                    ? "warning"
                                    : "danger"
                              }
                            >
                              {item.status === "success" ? "成功" : item.status === "skipped" ? "跳过" : "失败"}
                            </Badge>
                          </div>
                          <div className="mt-1 truncate text-xs text-slate-500">{item.input_path}</div>
                          <div className="mt-2 text-xs text-slate-600">{item.message}</div>
                          {item.output_path && <div className="mt-1 truncate text-xs text-slate-400">{item.output_path}</div>}
                          <div className="mt-2 flex flex-wrap gap-2">
                            {item.output_path ? (
                              <>
                                <Button variant="ghost" size="sm" onClick={() => void fileActions.openFile(item.output_path!)}>
                                  打开输出
                                </Button>
                                <Button variant="ghost" size="sm" onClick={() => void fileActions.revealInDir(item.output_path!)}>
                                  输出位置
                                </Button>
                              </>
                            ) : (
                              <Button variant="ghost" size="sm" onClick={() => void fileActions.revealInDir(item.input_path)}>
                                源文件位置
                              </Button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
