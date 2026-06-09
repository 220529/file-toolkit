import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  batchTrimVideos,
  cancelBatchVideoTrim,
  collectBatchVideoFiles,
  generatePreviewFrame,
  generateTimelineFrames,
  getVideoInfo,
  type BatchTrimProgress,
  type BatchTrimResult,
  type BatchVideoFile,
  type VideoInfo,
} from "../api/tauri";
import { useTaskReporter } from "../components/TaskCenter";
import { useToast } from "../components/Toast";
import { EmptyState } from "../components/ui/empty-state";
import { Icon } from "../components/ui/icon";
import { useFileActions } from "../hooks/useFileActions";
import { useWindowDrop } from "../hooks/useWindowDrop";
import { createTaskId } from "../utils/id";
import { safeListen } from "../utils/tauriEvent";
import {
  BatchVideoDropCard,
  BatchVideoFileListCard,
  BatchVideoResultCard,
  BatchVideoSettingsCard,
  BatchVideoSummaryCard,
} from "./batchVideoTrim/BatchVideoTrimPanels";
import { BatchVideoSamplePanel } from "./batchVideoTrim/BatchVideoSamplePanel";
import {
  BATCH_OUTPUT_DIR_STORAGE_KEY,
  SUPPORTED_VIDEO_EXTENSIONS,
  clamp,
  formatTime,
  getFrameDuration,
  getPreferredPreviewStrategy,
  getProgressText,
  snapTimeToFrame,
  type OutputMode,
  type PreviewStrategy,
} from "./batchVideoTrim/utils";

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

    return safeListen("batch-video-progress", (event) => {
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
      const incoming = await collectBatchVideoFiles(paths);
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
      const info = await getVideoInfo(path);
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
        const frames = await generateTimelineFrames(path, 10);
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
      const frame = await generatePreviewFrame(path, time);
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

    const taskId = createTaskId("batch-video-trim");
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
      const response = await batchTrimVideos({
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
      await cancelBatchVideoTrim(taskId);
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
      <BatchVideoDropCard
        dragging={dragging}
        onSelectFiles={() => void selectFiles()}
        onSelectFolder={() => void selectFolder()}
        processing={processing}
      />

      {files.length === 0 ? (
        <EmptyState
          icon={<Icon name="scissors" size={28} />}
          title="还没有待处理的视频"
          description="先导入一批素材，再在样本视频上设定片头结束点。"
        />
      ) : (
        <>
          <BatchVideoSummaryCard
            filesCount={files.length}
            reviewedCount={reviewedCount}
            samplePath={samplePath}
            totalSize={totalSize}
            trimTime={trimTime}
          />

          <div className="grid gap-6 xl:grid-cols-[minmax(0,1.45fr)_380px]">
            <BatchVideoSamplePanel
              currentPreviewTime={currentPreviewTime}
              filesCount={files.length}
              loadingSample={loadingSample}
              loadingTimeline={loadingTimeline}
              onJumpToTrimPoint={jumpToTrimPoint}
              onPreviewError={handlePreviewError}
              onPreviewLoadedMetadata={handlePreviewLoadedMetadata}
              onPreviewTimeUpdate={handlePreviewTimeUpdate}
              onResetTrimPoint={resetTrimPoint}
              onSelectNextSample={selectNextSample}
              onSelectPreviousSample={selectPreviousSample}
              onSelectRandomSample={selectRandomSample}
              onSetTrimToCurrentFrame={setTrimToCurrentFrame}
              onStepFrame={stepFrame}
              onSyncPreviewTime={syncPreviewTime}
              previewFrame={previewFrame}
              previewFrameError={previewFrameError}
              previewReady={previewReady}
              previewStrategy={previewStrategy}
              previewVideoRef={previewVideoRef}
              processing={processing}
              reviewedCount={reviewedCount}
              sampleIndex={sampleIndex}
              sampleInfo={sampleInfo}
              sampleKeptDuration={sampleKeptDuration}
              samplePath={samplePath}
              sampleVideoSrc={sampleVideoSrc}
              timelineFrames={timelineFrames}
              trimTime={trimTime}
            />

            <BatchVideoSettingsCard
              editingTrim={editingTrim}
              filesCount={files.length}
              onCancel={() => void cancelBatchTrim()}
              onChooseOutputDirectory={() => void chooseOutputDirectory()}
              onClearFiles={clearFiles}
              onInvalidTime={toast.error}
              onOutputModeChange={setOutputMode}
              onPreciseModeChange={setPreciseMode}
              onStart={() => void handleBatchTrim()}
              onSuffixChange={setSuffix}
              onTrimInputChange={setTrimInput}
              onTrimTimeChange={setTrimTime}
              outputDir={outputDir}
              outputMode={outputMode}
              preciseMode={preciseMode}
              processing={processing}
              progress={progress}
              sampleInfo={sampleInfo}
              setEditingTrim={setEditingTrim}
              setTrimInput={setTrimInput}
              suffix={suffix}
              trimInput={trimInput}
              trimTime={trimTime}
            />
          </div>

          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
            <BatchVideoFileListCard
              files={files}
              onRemoveFile={removeFile}
              onSelectSample={setSamplePath}
              processing={processing}
              samplePath={samplePath}
            />

            <BatchVideoResultCard
              firstSuccessOutput={firstSuccessOutput}
              onOpenFile={fileActions.openFile}
              onRevealInDir={fileActions.revealInDir}
              result={result}
            />
          </div>
        </>
      )}
    </div>
  );
}
