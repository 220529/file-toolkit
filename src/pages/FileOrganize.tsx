import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useState } from "react";
import {
  getPathMetadata,
  organizeFiles,
  pathExists,
  type OrganizeFilesResult,
  type OrganizeOperation,
  type PathMetadata,
} from "../api/tauri";
import { EmptyState } from "../components/ui/empty-state";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Icon } from "../components/ui/icon";
import { Modal } from "../components/ui/modal";
import { useTaskReporter } from "../components/TaskCenter";
import { useToast } from "../components/Toast";
import { useWindowDrop } from "../hooks/useWindowDrop";
import { cn } from "../utils/cn";
import { formatSize } from "../utils/format";
import type { DateGranularity, OrganizeFile, OrganizeMode, OrganizeRule } from "./fileOrganize/types";
import {
  buildOrganizePreview,
  collectOrganizeTargetPaths,
  hasBlockingOrganizeIssue,
  readyOrganizeOperations,
} from "./fileOrganize/utils";

interface Props {
  active?: boolean;
}

interface OrganizeUndoState {
  operations: OrganizeOperation[];
  count: number;
}

const modeOptions: Array<{ value: OrganizeMode; label: string; description: string }> = [
  { value: "date", label: "日期", description: "按修改时间归档" },
  { value: "type", label: "类型", description: "图片、视频、文档等" },
  { value: "extension", label: "扩展名", description: "按 jpg、pdf 等归档" },
];

const granularityOptions: Array<{ value: DateGranularity; label: string }> = [
  { value: "month", label: "按月" },
  { value: "day", label: "按日" },
  { value: "year", label: "按年" },
];

export default function FileOrganize({ active = true }: Props) {
  const [files, setFiles] = useState<OrganizeFile[]>([]);
  const [mode, setMode] = useState<OrganizeMode>("date");
  const [dateGranularity, setDateGranularity] = useState<DateGranularity>("month");
  const [outputDir, setOutputDir] = useState("");
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [organizing, setOrganizing] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [lastResult, setLastResult] = useState<OrganizeFilesResult | null>(null);
  const [undoState, setUndoState] = useState<OrganizeUndoState | null>(null);
  const [existingTargetPaths, setExistingTargetPaths] = useState<Set<string>>(() => new Set());
  const [checkingTargets, setCheckingTargets] = useState(false);
  const toast = useToast();
  const task = useTaskReporter("file-organize");
  const busy = organizing || undoing;

  const { dragging } = useWindowDrop({
    active,
    onDrop: (paths) => {
      if (busy) return;
      void addFiles(paths);
    },
  });

  const rule: OrganizeRule = useMemo(
    () => ({ mode, dateGranularity, outputDir }),
    [mode, dateGranularity, outputDir]
  );
  const basePreviewItems = useMemo(() => buildOrganizePreview(files, rule), [files, rule]);
  const targetPathsToCheck = useMemo(() => collectOrganizeTargetPaths(basePreviewItems), [basePreviewItems]);
  const targetCheckKey = useMemo(() => targetPathsToCheck.join("\n"), [targetPathsToCheck]);
  const previewItems = useMemo(
    () => buildOrganizePreview(files, rule, { existingTargetPaths }),
    [existingTargetPaths, files, rule]
  );
  const readyItems = previewItems.filter((item) => item.status === "ready");
  const blocked = hasBlockingOrganizeIssue(previewItems);
  const canOrganize = readyItems.length > 0 && !blocked && !busy && !loadingFiles && !checkingTargets;
  const canUndo = Boolean(undoState && undoState.count > 0 && !busy && !loadingFiles);

  useEffect(() => {
    if (targetPathsToCheck.length === 0) {
      setExistingTargetPaths((current) => (current.size === 0 ? current : new Set()));
      setCheckingTargets(false);
      return;
    }

    let cancelled = false;
    setCheckingTargets(true);
    void Promise.all(
      targetPathsToCheck.map(async (path) => {
        try {
          return [path, await pathExists(path)] as const;
        } catch {
          return [path, false] as const;
        }
      })
    )
      .then((results) => {
        if (cancelled) return;
        setExistingTargetPaths(new Set(results.filter(([, exists]) => exists).map(([path]) => path)));
      })
      .finally(() => {
        if (!cancelled) setCheckingTargets(false);
      });

    return () => {
      cancelled = true;
    };
  }, [targetCheckKey, targetPathsToCheck]);

  async function addFiles(paths: string[]) {
    if (paths.length === 0) return;
    setLoadingFiles(true);
    setLastResult(null);

    try {
      const currentPaths = new Set(files.map((file) => file.path));
      const nextFiles: OrganizeFile[] = [];
      let skipped = 0;

      for (const path of paths) {
        if (!path || currentPaths.has(path)) continue;
        try {
          const metadata = await getPathMetadata(path);
          if (!metadata.is_file) {
            skipped += 1;
            continue;
          }
          nextFiles.push(toOrganizeFile(path, metadata));
          currentPaths.add(path);
        } catch {
          skipped += 1;
        }
      }

      if (nextFiles.length > 0) {
        setFiles((current) => [...current, ...nextFiles]);
        toast.success(`已添加 ${nextFiles.length} 个文件`);
      }
      if (skipped > 0) {
        toast.warning(`已跳过 ${skipped} 个不可归类项目`);
      }
    } finally {
      setLoadingFiles(false);
    }
  }

  async function chooseFiles() {
    if (busy || loadingFiles) return;
    const selected = await open({
      multiple: true,
      directory: false,
      title: "选择要归类的文件",
    });
    if (Array.isArray(selected)) {
      await addFiles(selected);
    } else if (typeof selected === "string") {
      await addFiles([selected]);
    }
  }

  async function chooseOutputDir() {
    if (busy) return;
    const selected = await open({
      multiple: false,
      directory: true,
      title: "选择归类目标目录",
    });
    if (typeof selected === "string") {
      setOutputDir(selected);
      setLastResult(null);
    }
  }

  function requestOrganizeConfirmation() {
    if (!canOrganize) return;
    setConfirmOpen(true);
  }

  async function executeOrganize() {
    if (!canOrganize) return;
    setConfirmOpen(false);
    const operations = readyOrganizeOperations(previewItems);
    setOrganizing(true);
    task.reportTask({
      title: "文件归类",
      stage: "移动文件",
      detail: `${operations.length} 个文件`,
    });

    try {
      const result = await organizeFiles({ operations });
      setLastResult(result);
      const successfulItems = result.items.filter((item) => item.ok);
      const moved = new Set(successfulItems.map((item) => item.from));
      setFiles((current) => current.filter((file) => !moved.has(file.path)));
      setUndoState(buildOrganizeUndoState(successfulItems));
      toast.success(`已归类 ${result.moved} 个文件`);
      task.reportTask({
        title: "文件归类",
        stage: "归类完成",
        detail: `${result.moved}/${result.total} 个文件`,
        progress: 100,
        status: result.failed > 0 ? "error" : "success",
      });
      window.setTimeout(task.clearTask, 1200);
    } catch (error) {
      toast.error("归类失败: " + error);
      task.reportTask({
        title: "文件归类",
        stage: "归类失败",
        detail: String(error),
        progress: 100,
        status: "error",
      });
      window.setTimeout(task.clearTask, 1600);
    } finally {
      setOrganizing(false);
    }
  }

  async function undoLastOrganize() {
    if (!undoState || !canUndo) return;
    setUndoing(true);
    task.reportTask({
      title: "文件归类",
      stage: "撤销归类",
      detail: `${undoState.count} 个文件`,
    });

    try {
      const result = await organizeFiles({ operations: undoState.operations });
      setLastResult(result);
      const restoredFiles = await loadOrganizeFiles(result.items.filter((item) => item.ok).map((item) => item.to));
      if (restoredFiles.length > 0) {
        setFiles((current) => mergeOrganizeFiles(current, restoredFiles));
      }
      setUndoState(buildRetryUndoState(result.items.filter((item) => !item.ok)));
      if (result.failed > 0) {
        toast.warning(`已撤销 ${result.moved} 个文件，${result.failed} 个失败`);
      } else {
        toast.success(`已撤销 ${result.moved} 个文件`);
      }
      task.reportTask({
        title: "文件归类",
        stage: result.failed > 0 ? "撤销部分失败" : "撤销完成",
        detail: `${result.moved}/${result.total} 个文件`,
        progress: 100,
        status: result.failed > 0 ? "error" : "success",
      });
      window.setTimeout(task.clearTask, result.failed > 0 ? 1600 : 1200);
    } catch (error) {
      toast.error("撤销失败: " + error);
      task.reportTask({
        title: "文件归类",
        stage: "撤销失败",
        detail: String(error),
        progress: 100,
        status: "error",
      });
      window.setTimeout(task.clearTask, 1600);
    } finally {
      setUndoing(false);
    }
  }

  return (
    <div className="mx-auto max-w-[1320px] space-y-3">
      <div className="grid min-h-[calc(100vh-150px)] gap-3 lg:grid-cols-[390px_minmax(0,1fr)]">
        <Card className="overflow-hidden">
          <CardHeader>
            <div>
              <CardTitle>文件归类</CardTitle>
              <CardDescription className="mt-1">按日期、类型或扩展名整理到目标目录。</CardDescription>
            </div>
            <Button variant="primary" onClick={() => void chooseFiles()} disabled={busy || loadingFiles}>
              <Icon name="file" size={15} />
              添加文件
            </Button>
          </CardHeader>
          <CardContent className="space-y-4">
            <button
              type="button"
              onClick={() => void chooseFiles()}
              className={cn(
                "flex min-h-[128px] w-full cursor-pointer flex-col items-center justify-center rounded-[8px] border border-dashed border-slate-300 bg-slate-50 px-4 py-5 text-center transition",
                dragging && active && "border-blue-300 bg-blue-50"
              )}
              disabled={busy || loadingFiles}
            >
              <Icon name={dragging ? "folderOpen" : "folder"} size={24} className="text-[var(--brand-700)]" />
              <div className="mt-2 text-sm font-semibold text-slate-800">
                {dragging ? "松开以添加文件" : loadingFiles ? "读取文件信息中" : "拖入文件，或点击选择"}
              </div>
              <div className="mt-1 text-xs text-slate-500">已选择 {files.length} 个文件</div>
            </button>

            <RuleSection title="目标目录">
              <div className="flex gap-2">
                <div className="min-w-0 flex-1 rounded-[8px] border border-slate-200 bg-white px-3 py-2">
                  <div className={cn("truncate text-sm", outputDir ? "text-slate-800" : "text-slate-400")}>
                    {outputDir || "请选择一个用于接收归类文件的目录"}
                  </div>
                </div>
                <Button variant="secondary" onClick={() => void chooseOutputDir()} disabled={busy}>
                  <Icon name="folderOpen" size={15} />
                  选择
                </Button>
              </div>
            </RuleSection>

            <RuleSection title="归类方式">
              <div className="grid gap-2">
                {modeOptions.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => {
                      setMode(option.value);
                      setLastResult(null);
                    }}
                    className={cn(
                      "flex items-center justify-between rounded-[8px] border px-3 py-2 text-left transition",
                      mode === option.value
                        ? "border-blue-200 bg-blue-50 text-blue-800"
                        : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
                    )}
                  >
                    <span>
                      <span className="block text-sm font-semibold">{option.label}</span>
                      <span className="block text-[11px] text-slate-500">{option.description}</span>
                    </span>
                    {mode === option.value && <Icon name="check" size={15} />}
                  </button>
                ))}
              </div>
              {mode === "date" && (
                <SegmentedControl
                  value={dateGranularity}
                  options={granularityOptions}
                  onChange={(value) => {
                    setDateGranularity(value);
                    setLastResult(null);
                  }}
                />
              )}
            </RuleSection>

            <div className="grid grid-cols-3 gap-2">
              <SummaryStat label="文件" value={String(files.length)} />
              <SummaryStat label="可执行" value={String(readyItems.length)} />
              <SummaryStat label="问题" value={String(previewItems.length - readyItems.length)} tone={blocked ? "warning" : "default"} />
            </div>

            <div className="flex gap-2">
              <Button
                variant="ghost"
                className="flex-1"
                onClick={() => {
                  setFiles([]);
                  setLastResult(null);
                  setUndoState(null);
                }}
                disabled={busy || files.length === 0}
              >
                清空文件
              </Button>
              <Button
                variant="secondary"
                className="flex-1"
                onClick={() => {
                  setMode("date");
                  setDateGranularity("month");
                  setLastResult(null);
                }}
                disabled={busy}
              >
                重置规则
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="flex min-h-[520px] flex-col overflow-hidden">
          <CardHeader>
            <div>
              <CardTitle>预览</CardTitle>
              <CardDescription className="mt-1">
                {readyItems.length} 个可移动，{previewItems.length - readyItems.length} 个需要处理
                {checkingTargets ? "，正在检查目标路径" : ""}
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              {lastResult && (
                <Badge tone={lastResult.failed > 0 ? "warning" : "success"}>
                  {lastResult.moved}/{lastResult.total}
                </Badge>
              )}
              {undoState && undoState.count > 0 && (
                <Button variant="secondary" onClick={() => void undoLastOrganize()} disabled={!canUndo}>
                  <Icon name="reset" size={15} />
                  {undoing ? "撤销中" : "撤销上次"}
                </Button>
              )}
              <Button variant="primary" onClick={requestOrganizeConfirmation} disabled={!canOrganize}>
                <Icon name="check" size={15} />
                {organizing ? "执行中" : "执行归类"}
              </Button>
            </div>
          </CardHeader>
          <CardContent className="min-h-0 flex-1 overflow-auto">
            {previewItems.length === 0 ? (
              <EmptyState
                icon={<Icon name="folder" size={24} />}
                title="还没有文件"
                description="添加文件并选择目标目录后，会在这里预览每个文件的目标位置。"
              />
            ) : (
              <div className="overflow-hidden rounded-[8px] border border-slate-200">
                <div className="grid grid-cols-[minmax(180px,1.1fr)_minmax(220px,1fr)_96px] border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-500">
                  <div>原文件</div>
                  <div>目标位置</div>
                  <div className="text-right">状态</div>
                </div>
                <div className="max-h-[calc(100vh-300px)] overflow-auto">
                  {previewItems.map((item) => (
                    <div
                      key={item.path}
                      className="grid grid-cols-[minmax(180px,1.1fr)_minmax(220px,1fr)_96px] items-center gap-3 border-b border-slate-100 px-3 py-2 last:border-b-0"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-slate-800">{item.fileName}</div>
                        <div className="flex min-w-0 items-center gap-2 text-[11px] text-slate-400">
                          <span className="truncate">{item.path}</span>
                          <span className="shrink-0">{formatSize(item.size)}</span>
                        </div>
                      </div>
                      <div className="min-w-0">
                        <div className={cn("truncate text-sm font-medium", item.status === "ready" ? "text-slate-900" : "text-amber-700")}>
                          {item.targetFolder || "未设置"}
                        </div>
                        <div className="truncate text-[11px] text-slate-400">{item.targetPath || "等待选择目标目录"}</div>
                        {item.reason && <div className="truncate text-[11px] text-amber-600">{item.reason}</div>}
                      </div>
                      <div className="text-right">
                        <PreviewStatusBadge status={item.status} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        accessibleTitle="确认文件归类"
        className="max-w-xl"
      >
        <div className="space-y-5 p-6">
          <div>
            <CardTitle className="text-xl">确认移动 {readyItems.length} 个文件？</CardTitle>
            <CardDescription className="mt-2">
              操作会把文件移动到目标目录下的分类子目录。后端会再次拒绝覆盖已有文件。
            </CardDescription>
          </div>
          <div className="max-h-[260px] overflow-auto rounded-[8px] border border-slate-200">
            {readyItems.slice(0, 8).map((item) => (
              <div key={item.path} className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 border-b border-slate-100 px-3 py-2 text-xs last:border-b-0">
                <div className="truncate text-slate-500">{item.fileName}</div>
                <Icon name="chevronRight" size={14} className="text-slate-400" />
                <div className="truncate font-medium text-slate-900">{item.targetFolder}</div>
              </div>
            ))}
            {readyItems.length > 8 && (
              <div className="px-3 py-2 text-xs text-slate-500">
                还有 {readyItems.length - 8} 个文件未显示
              </div>
            )}
          </div>
          <div className="flex justify-end gap-3">
            <Button variant="secondary" onClick={() => setConfirmOpen(false)} disabled={busy}>
              取消
            </Button>
            <Button variant="primary" onClick={() => void executeOrganize()} disabled={busy}>
              {organizing ? "执行中" : "确认执行"}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function buildOrganizeUndoState(items: Array<{ from: string; to: string; ok: boolean }>): OrganizeUndoState | null {
  const operations = items
    .filter((item) => item.ok)
    .map((item) => ({ from: item.to, to: item.from }))
    .reverse();

  return createOrganizeUndoState(operations);
}

function buildRetryUndoState(items: Array<{ from: string; to: string; ok: boolean }>): OrganizeUndoState | null {
  const operations = items
    .filter((item) => !item.ok)
    .map((item) => ({ from: item.from, to: item.to }));

  return createOrganizeUndoState(operations);
}

function createOrganizeUndoState(operations: OrganizeOperation[]): OrganizeUndoState | null {
  if (operations.length === 0) return null;
  return { operations, count: operations.length };
}

async function loadOrganizeFiles(paths: string[]): Promise<OrganizeFile[]> {
  const files: OrganizeFile[] = [];
  for (const path of paths) {
    try {
      const metadata = await getPathMetadata(path);
      if (metadata.is_file) {
        files.push(toOrganizeFile(path, metadata));
      }
    } catch {
      // The undo already succeeded on disk; a transient metadata read failure should not fail the action.
    }
  }
  return files;
}

function mergeOrganizeFiles(current: OrganizeFile[], nextFiles: OrganizeFile[]) {
  const seen = new Set(current.map((file) => file.path));
  const merged = [...current];
  for (const file of nextFiles) {
    if (seen.has(file.path)) continue;
    seen.add(file.path);
    merged.push(file);
  }
  return merged;
}

function toOrganizeFile(path: string, metadata: PathMetadata): OrganizeFile {
  return {
    path,
    size: metadata.size,
    modifiedMs: metadata.modified_ms,
  };
}

function RuleSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3 rounded-[8px] border border-slate-200 bg-slate-50 p-3">
      <div className="text-xs font-semibold text-slate-700">{title}</div>
      {children}
    </div>
  );
}

function SummaryStat({ label, value, tone = "default" }: { label: string; value: string; tone?: "default" | "warning" }) {
  return (
    <div className={cn("rounded-[8px] border px-3 py-2", tone === "warning" ? "border-amber-200 bg-amber-50" : "border-slate-200 bg-slate-50")}>
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className={cn("mt-1 text-lg font-semibold", tone === "warning" ? "text-amber-700" : "text-slate-900")}>{value}</div>
    </div>
  );
}

function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="grid grid-cols-3 gap-1 rounded-[8px] border border-slate-200 bg-white p-1">
      {options.map((item) => (
        <button
          key={item.value}
          type="button"
          onClick={() => onChange(item.value)}
          className={cn(
            "h-8 rounded-[6px] text-xs font-medium transition",
            value === item.value ? "bg-slate-900 text-white" : "text-slate-500 hover:bg-slate-50 hover:text-slate-900"
          )}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

function PreviewStatusBadge({ status }: { status: string }) {
  if (status === "ready") return <Badge tone="success">可执行</Badge>;
  if (status === "unchanged") return <Badge tone="default">无变化</Badge>;
  if (status === "duplicate") return <Badge tone="danger">重复</Badge>;
  if (status === "exists") return <Badge tone="danger">已存在</Badge>;
  return <Badge tone="warning">无效</Badge>;
}
