import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { cancelConvert, convertVideo, getFileSize } from "../api/tauri";
import { useTaskReporter } from "../components/TaskCenter";
import { useToast } from "../components/Toast";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Icon } from "../components/ui/icon";
import { Progress } from "../components/ui/progress";
import { useFileActions } from "../hooks/useFileActions";
import { useWindowDrop } from "../hooks/useWindowDrop";
import { cn } from "../utils/cn";
import { createId } from "../utils/id";
import { safeListen } from "../utils/tauriEvent";
import {
  fileSystemCollisionKey,
  getBaseName,
  getDirName,
  getExtension,
  getPathSeparator,
  joinPath,
  stripExtension,
} from "../utils/path";

interface Props {
  active: boolean;
}

type Format = "mp4" | "mov" | "gif";
type Quality = "high" | "medium" | "low";
type FileStatus = "pending" | "converting" | "done" | "error";

interface FileItem {
  id: string;
  path: string;
  name: string;
  sourceFormat: string;
  size: number;
  status: FileStatus;
  progress: number;
  error?: string;
  outputPath?: string;
  outputSize?: number;
  duration?: number;
  startTime?: number;
}

const FORMATS: { value: Format; label: string; hint: string }[] = [
  { value: "mp4", label: "MP4", hint: "兼容性最好" },
  { value: "mov", label: "MOV", hint: "适合剪辑流程" },
  { value: "gif", label: "GIF", hint: "轻量动图" },
];

const QUALITIES: { value: Quality; label: string; hint: string }[] = [
  { value: "high", label: "高画质", hint: "文件更大" },
  { value: "medium", label: "均衡", hint: "默认推荐" },
  { value: "low", label: "小文件", hint: "压缩更强" },
];

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="px-5 py-5">
        <div className="text-xs font-medium text-slate-400">{label}</div>
        <div className="mt-3 text-3xl font-semibold text-slate-950">{value}</div>
      </CardContent>
    </Card>
  );
}

export default function VideoConvert({ active }: Props) {
  const [files, setFiles] = useState<FileItem[]>([]);
  const [targetFormat, setTargetFormat] = useState<Format>("mp4");
  const [quality, setQuality] = useState<Quality>("medium");
  const [converting, setConverting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [addingFiles, setAddingFiles] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const cancelRequestedRef = useRef(false);
  const currentTaskIdRef = useRef<string | null>(null);
  const currentFileIdRef = useRef<string | null>(null);
  const addingFilesRef = useRef(false);
  const toast = useToast();
  const task = useTaskReporter("video-convert");
  const fileActions = useFileActions();

  useEffect(() => {
    if (!active) return;

    return safeListen("convert-progress", (event) => {
      const currentFileId = currentFileIdRef.current;
      if (event.payload.task_id === currentTaskIdRef.current && currentFileId) {
        setFiles((prev) =>
          prev.map((file) =>
            file.id === currentFileId ? { ...file, progress: Math.round(event.payload.percent) } : file
          )
        );
      }
    });
  }, [active]);

  const { dragging } = useWindowDrop({
    active: active && !converting && !addingFiles,
    onDrop: (paths) => {
      void addFiles(paths);
    },
  });

  async function addFiles(paths: string[]) {
    if (converting || addingFilesRef.current || paths.length === 0) return;
    addingFilesRef.current = true;
    setAddingFiles(true);
    const videoExts = ["mov", "mp4", "avi", "mkv", "webm", "flv", "wmv"];
    const uniquePaths = Array.from(
      new Map(paths.map((path) => [fileSystemCollisionKey(path), path])).values()
    );
    const existingPaths = new Set(files.map((file) => fileSystemCollisionKey(file.path)));
    const newPaths = uniquePaths.filter((path) => {
      const ext = getExtension(path).toLowerCase();
      return videoExts.includes(ext) && !existingPaths.has(fileSystemCollisionKey(path));
    });

    try {
      const newFiles: FileItem[] = [];
      let unreadableCount = 0;
      for (const path of newPaths) {
        try {
          const size = await getFileSize(path);
          newFiles.push({
            id: createId("video-convert"),
            path,
            name: getBaseName(path),
            sourceFormat: getExtension(path).toLowerCase(),
            size,
            status: "pending",
            progress: 0,
          });
        } catch {
          unreadableCount += 1;
        }
      }

      if (newFiles.length > 0) {
        setFiles((current) => {
          const existing = new Set(current.map((file) => file.path));
          return [...current, ...newFiles.filter((file) => !existing.has(file.path))];
        });
        toast.success(`已添加 ${newFiles.length} 个视频`);
      }

      const skippedCount = uniquePaths.length - newPaths.length + unreadableCount;
      if (skippedCount > 0) {
        toast.warning(`已跳过 ${skippedCount} 个重复、不支持或不可读取的文件`);
      }
    } finally {
      addingFilesRef.current = false;
      setAddingFiles(false);
    }
  }

  async function handleSelectFiles() {
    if (converting || addingFilesRef.current) return;
    const selected = await open({
      title: "选择视频文件",
      multiple: true,
      filters: [{ name: "视频", extensions: ["mov", "mp4", "avi", "mkv", "webm"] }],
    });
    if (selected) {
      await addFiles(Array.isArray(selected) ? selected : [selected]);
    }
  }

  function removeFile(id: string) {
    setFiles((prev) => prev.filter((file) => file.id !== id));
  }

  async function startConvert() {
    const pendingFiles = files.filter((file) => file.status === "pending");
    if (pendingFiles.length === 0 || converting || addingFilesRef.current) return;

    currentTaskIdRef.current = null;
    currentFileIdRef.current = null;
    setConverting(true);
    setCancelling(false);
    cancelRequestedRef.current = false;
    let successCount = 0;
    let failedCount = 0;
    let wasCancelled = false;

    try {
      for (let index = 0; index < files.length; index++) {
        if (cancelRequestedRef.current) {
          wasCancelled = true;
          break;
        }
        if (files[index].status !== "pending") continue;

        setCurrentIndex(index);
        setFiles((prev) =>
          prev.map((file, current) =>
            current === index
              ? { ...file, status: "converting", progress: 0, error: undefined, startTime: Date.now() }
              : file
          )
        );

        const file = files[index];
        const commandTaskId = createId("video-convert-file");
        currentTaskIdRef.current = commandTaskId;
        currentFileIdRef.current = file.id;
        const requestedOutputPath = joinPath(
          getDirName(file.path),
          `${stripExtension(file.name)}_converted.${targetFormat}`,
          getPathSeparator(file.path)
        );

        try {
          const outputPath = await convertVideo({
            taskId: commandTaskId,
            input: file.path,
            output: requestedOutputPath,
            format: targetFormat,
            quality,
          });

          let outputSize = 0;
          try {
            outputSize = await getFileSize(outputPath);
          } catch {
            // The output remains usable even if size metadata is unavailable.
          }

          setFiles((prev) =>
            prev.map((item, current) => {
              if (current !== index) return item;
              const duration = item.startTime ? Math.round((Date.now() - item.startTime) / 1000) : 0;
              return { ...item, status: "done", progress: 100, outputPath, outputSize, duration };
            })
          );
          successCount += 1;
        } catch (e) {
          const message = String(e);
          if (message.includes("取消")) {
            setFiles((prev) =>
              prev.map((item, current) =>
                current === index
                  ? { ...item, status: "pending", progress: 0, error: undefined, startTime: undefined }
                  : item
              )
            );
            wasCancelled = true;
            break;
          }
          setFiles((prev) =>
            prev.map((item, current) => {
              if (current !== index) return item;
              const duration = item.startTime ? Math.round((Date.now() - item.startTime) / 1000) : 0;
              return { ...item, status: "error", error: message, duration };
            })
          );
          failedCount += 1;
        } finally {
          if (currentTaskIdRef.current === commandTaskId) {
            currentTaskIdRef.current = null;
            currentFileIdRef.current = null;
          }
        }
      }

      if (wasCancelled) {
        toast.info("已取消转换，未完成项目仍保留在队列中");
      } else if (successCount > 0 && failedCount === 0) {
        toast.success(`转换完成：${successCount} 个文件`);
      } else if (successCount > 0 || failedCount > 0) {
        toast.warning(`转换结束：${successCount} 个成功，${failedCount} 个失败`);
      }
    } finally {
      setConverting(false);
      setCancelling(false);
      setCurrentIndex(-1);
      cancelRequestedRef.current = false;
      currentTaskIdRef.current = null;
      currentFileIdRef.current = null;
    }
  }

  async function handleCancel() {
    const taskId = currentTaskIdRef.current;
    if (!converting || cancelling) return;
    cancelRequestedRef.current = true;
    setCancelling(true);
    try {
      if (taskId) {
        await cancelConvert(taskId);
      }
    } catch (error) {
      cancelRequestedRef.current = false;
      setCancelling(false);
      toast.error("取消失败: " + error);
    }
  }

  const doneCount = files.filter((file) => file.status === "done").length;
  const failedCount = files.filter((file) => file.status === "error").length;
  const pendingCount = files.filter((file) => file.status === "pending").length;

  useEffect(() => {
    if (!converting) {
      task.clearTask();
      return;
    }

    const totalCount = files.length || 1;
    const completedCount = files.filter((file) => file.status === "done" || file.status === "error").length;
    const currentProgress = currentIndex >= 0 && files[currentIndex] ? files[currentIndex].progress : 0;

    task.reportTask({
      title: "格式转换",
      stage: cancelling ? "正在取消当前文件" : `已完成 ${completedCount} / ${totalCount}`,
      detail: currentIndex >= 0 && files[currentIndex] ? files[currentIndex].name : "准备转换",
      progress: ((completedCount + currentProgress / 100) / totalCount) * 100,
      cancellable: !cancelling,
      onCancel: handleCancel,
    });
  }, [cancelling, converting, files, currentIndex]);

  return (
    <div className="mx-auto max-w-[1360px] space-y-4">
      <Card className="overflow-hidden">
        <CardContent className="px-5 py-5">
          <button
            type="button"
            disabled={converting || addingFiles}
            onClick={() => void handleSelectFiles()}
            className={cn(
              "drop-zone flex w-full flex-col items-center justify-center disabled:cursor-not-allowed",
              dragging && active && "dragging",
              (converting || addingFiles) && "cursor-not-allowed opacity-70"
            )}
          >
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-[8px] border border-slate-200 bg-slate-50 text-[var(--brand-700)]">
              <Icon
                name={dragging ? "folderOpen" : "video"}
                size={30}
                className={converting ? "animate-pulse" : undefined}
              />
            </div>
            <div className="text-lg font-semibold text-slate-900">
              {cancelling
                ? "正在取消转换"
                : converting
                  ? "转换任务进行中"
                  : addingFiles
                    ? "正在读取视频信息"
                    : dragging
                      ? "松开以添加视频文件"
                      : "拖入视频，或点击选择"}
            </div>
            <div className="mt-5">
              <span className="inline-flex h-8 items-center rounded-[8px] border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 shadow-sm">
                {converting ? "处理中…" : addingFiles ? "读取中…" : "添加视频"}
              </span>
            </div>
          </button>
          {files.length > 0 && (
            <div className="mt-4 flex flex-wrap items-center gap-3 rounded-[10px] border border-slate-200 bg-slate-50 px-4 py-3">
              <Badge tone="info">任务队列</Badge>
              <div className="text-sm text-slate-600">已选择 {files.length} 个文件</div>
              {doneCount > 0 && <Badge tone="success">完成 {doneCount}</Badge>}
              {failedCount > 0 && <Badge tone="danger">失败 {failedCount}</Badge>}
            </div>
          )}
        </CardContent>
      </Card>

      {files.length === 0 ? null : (
        <>
          <div className="grid gap-4 lg:grid-cols-3">
            <SummaryCard label="队列总数" value={files.length.toLocaleString()} />
            <SummaryCard label="待转换" value={pendingCount.toLocaleString()} />
            <SummaryCard label="已完成" value={doneCount.toLocaleString()} />
          </div>

          <div className="grid gap-6 xl:grid-cols-[minmax(0,1.5fr)_360px]">
            <Card className="overflow-hidden">
              <CardHeader>
                <div>
                  <CardTitle>转换队列</CardTitle>
                </div>
                {!converting && (
                  <Button variant="secondary" size="sm" onClick={() => void handleSelectFiles()} disabled={addingFiles}>
                    继续添加
                  </Button>
                )}
              </CardHeader>
              <CardContent className="space-y-3 px-3 py-3">
                {files.map((file, index) => (
                  <div
                    key={file.id}
                    className={cn(
                      "rounded-[10px] border px-4 py-4",
                      file.status === "done" && "border-emerald-100 bg-emerald-50/70",
                      file.status === "converting" && "border-blue-100 bg-blue-50/80",
                      file.status === "error" && "border-rose-100 bg-rose-50/70",
                      file.status === "pending" && "border-slate-200 bg-slate-50/80"
                    )}
                  >
                    <div className="flex items-start gap-4">
                      <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[8px] border border-slate-200 bg-white text-sm font-medium">
                        {index + 1}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <div className="truncate text-sm font-medium text-slate-900">{file.name}</div>
                          <Badge tone="default">{file.sourceFormat.toUpperCase()}</Badge>
                        </div>
                        <div className="mt-1 text-xs text-slate-500">
                          {formatSize(file.size)}
                          {file.outputSize !== undefined && <span className="ml-2">→ {formatSize(file.outputSize)}</span>}
                        </div>
                        {file.outputPath && <div className="mt-1 truncate text-xs text-slate-400">{file.outputPath}</div>}
                        {file.error && <div className="mt-1 text-xs text-rose-600">{file.error}</div>}
                        {file.status === "converting" && (
                          <div className="mt-3">
                            <Progress value={file.progress} />
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        {file.status === "pending" && <Badge tone="default">等待中</Badge>}
                        {file.status === "converting" && <Badge tone="info">{file.progress}%</Badge>}
                        {file.status === "done" && <Badge tone="success">完成</Badge>}
                        {file.status === "error" && <Badge tone="danger">失败</Badge>}
                        {!converting && file.status !== "converting" && (
                          <Button variant="ghost" size="sm" onClick={() => removeFile(file.id)}>
                            移除
                          </Button>
                        )}
                      </div>
                    </div>
                    {file.status === "done" && file.outputPath && (
                      <div className="mt-3 flex items-center gap-2 border-t border-emerald-100 pt-3">
                        <Button variant="secondary" size="sm" onClick={() => void fileActions.openFile(file.outputPath!)}>
                          打开文件
                        </Button>
                        <Button variant="secondary" size="sm" onClick={() => void fileActions.revealInDir(file.outputPath!)}>
                          打开位置
                        </Button>
                        {typeof file.duration === "number" && <span className="text-xs text-slate-500">耗时 {file.duration}s</span>}
                      </div>
                    )}
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <div>
                  <CardTitle>输出设置</CardTitle>
                </div>
              </CardHeader>
              <CardContent className="space-y-6">
                <div>
                  <div className="mb-3 text-sm font-medium text-slate-800">输出格式</div>
                  <div className="space-y-2">
                    {FORMATS.map((item) => (
                      <button
                        key={item.value}
                        onClick={() => !converting && setTargetFormat(item.value)}
                        disabled={converting}
                        className={cn(
                          "flex w-full items-center justify-between rounded-[10px] border px-4 py-3 text-left transition",
                          targetFormat === item.value
                            ? "border-[var(--brand-300)] bg-[var(--brand-50)]"
                            : "border-slate-200 bg-white hover:border-slate-300"
                        )}
                      >
                        <div>
                          <div className="text-sm font-medium text-slate-900">{item.label}</div>
                          <div className="text-xs text-slate-500">{item.hint}</div>
                        </div>
                        {targetFormat === item.value && <Badge tone="info">当前</Badge>}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <div className="mb-3 text-sm font-medium text-slate-800">画质策略</div>
                  <div className="space-y-2">
                    {QUALITIES.map((item) => (
                      <button
                        key={item.value}
                        onClick={() => !converting && setQuality(item.value)}
                        disabled={converting}
                        className={cn(
                          "flex w-full items-center justify-between rounded-[10px] border px-4 py-3 text-left transition",
                          quality === item.value
                            ? "border-[var(--brand-300)] bg-[var(--brand-50)]"
                            : "border-slate-200 bg-white hover:border-slate-300"
                        )}
                      >
                        <div>
                          <div className="text-sm font-medium text-slate-900">{item.label}</div>
                          <div className="text-xs text-slate-500">{item.hint}</div>
                        </div>
                        {quality === item.value && <Badge tone="info">当前</Badge>}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-3 border-t border-slate-100 pt-4">
                  {!converting ? (
                    <>
                      <Button
                        variant="primary"
                        className="w-full"
                        onClick={startConvert}
                        disabled={pendingCount === 0 || addingFiles}
                      >
                        开始转换{pendingCount > 0 ? ` (${pendingCount})` : ""}
                      </Button>
                      <Button variant="secondary" className="w-full" onClick={() => setFiles([])} disabled={addingFiles}>
                        清空队列
                      </Button>
                    </>
                  ) : (
                    <Button variant="danger" className="w-full" onClick={() => void handleCancel()} disabled={cancelling}>
                      {cancelling ? "取消中…" : "取消当前批次"}
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
