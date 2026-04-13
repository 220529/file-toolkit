import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirm } from "@tauri-apps/plugin-dialog";
import { flushSync } from "react-dom";
import { useFileActions } from "../hooks/useFileActions";
import DropZone from "../components/DropZone";
import { useTaskReporter } from "../components/TaskCenter";
import { useToast } from "../components/Toast";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { EmptyState } from "../components/ui/empty-state";
import { Modal } from "../components/ui/modal";
import { Progress } from "../components/ui/progress";
import { Switch } from "../components/ui/switch";
import { safeListen } from "../utils/tauriEvent";
import { formatSize } from "../utils/format";
import { cn } from "../utils/cn";

interface FileInfo {
  path: string;
  name: string;
  size: number;
  created: number;
  modified: number;
}

interface DuplicateGroup {
  hash: string;
  size: number;
  files: FileInfo[];
}

interface DedupIssue {
  path: string;
  reason: string;
}

interface DedupResult {
  groups: DuplicateGroup[];
  total_groups: number;
  total_duplicates: number;
  wasted_size: number;
  skipped_files: number;
  unreadable_files: number;
  permission_denied_files: number;
  hash_failed_files: number;
  sample_errors: DedupIssue[];
}

interface DedupProgress {
  task_id: string;
  stage: string;
  current: number;
  total: number;
  percent: number;
}

interface DeleteFailure {
  path: string;
  reason: string;
}

interface DeleteFilesResult {
  deleted_count: number;
  failed: DeleteFailure[];
}

interface DeleteGroupInput {
  files: string[];
}

interface DedupStepSnapshot {
  scannedFiles: number;
  sampleCurrent: number;
  sampleTotal: number;
  confirmCurrent: number;
  confirmTotal: number;
}

type DedupScope = "media" | "all";
type VirtualItem = {
  group: DuplicateGroup;
  index: number;
  top: number;
  height: number;
};

const DEDUP_STAGE_ORDER: Record<string, number> = {
  "准备扫描文件夹": 0,
  "扫描文件": 1,
  "初步筛选重复文件": 2,
  "确认重复文件": 3,
  "完成": 4,
};
const VIRTUAL_OVERSCAN = 900;

function estimateGroupHeight(group: DuplicateGroup, expanded: boolean) {
  const base = 148;
  if (!expanded) return base;
  return base + group.files.length * 78 + 16;
}

function getDedupProgressText(progress: DedupProgress) {
  switch (progress.stage) {
    case "准备扫描文件夹":
      return "准备中";
    case "扫描文件":
      return `已扫描 ${progress.current.toLocaleString()} 个文件`;
    case "初步筛选重复文件":
      return progress.total > 0
        ? `候选 ${progress.current.toLocaleString()} / ${progress.total.toLocaleString()}`
        : "筛选中";
    case "确认重复文件":
      return progress.total > 0
        ? `确认 ${progress.current.toLocaleString()} / ${progress.total.toLocaleString()}`
        : "确认中";
    default:
      return progress.total > 0
        ? `${progress.current.toLocaleString()} / ${progress.total.toLocaleString()}`
        : `${progress.current.toLocaleString()}`;
  }
}

function createEmptyStepSnapshot(): DedupStepSnapshot {
  return {
    scannedFiles: 0,
    sampleCurrent: 0,
    sampleTotal: 0,
    confirmCurrent: 0,
    confirmTotal: 0,
  };
}

function getStepStatus(currentStage: string, stepStage: string) {
  const currentOrder = DEDUP_STAGE_ORDER[currentStage] ?? 0;
  const stepOrder = DEDUP_STAGE_ORDER[stepStage] ?? 0;

  if (currentOrder > stepOrder) return "done";
  if (currentOrder === stepOrder) return "active";
  return "pending";
}

function getStepProgress(
  currentStage: string,
  stepStage: string,
  current: number,
  total: number
) {
  const status = getStepStatus(currentStage, stepStage);

  if (status === "done") {
    return { value: 100, indeterminate: false };
  }

  if (status === "pending") {
    return { value: 0, indeterminate: false };
  }

  if (stepStage === "扫描文件") {
    return { value: 0, indeterminate: true };
  }

  if (total > 0) {
    return { value: (current / total) * 100, indeterminate: false };
  }

  return { value: 0, indeterminate: true };
}

function formatDate(timestamp: number) {
  if (!timestamp) return "未知时间";
  return new Date(timestamp * 1000).toLocaleString();
}

function compareTimestamp(a: number, b: number) {
  if (!a || !b || a === b) return 0;
  return a - b;
}

function comparePreferredFiles(a: FileInfo, b: FileInfo) {
  const createdCmp = compareTimestamp(a.created, b.created);
  if (createdCmp !== 0) return createdCmp;

  const modifiedCmp = compareTimestamp(a.modified, b.modified);
  if (modifiedCmp !== 0) return modifiedCmp;

  return a.path.localeCompare(b.path, "zh-CN");
}

function getSortedFiles(group: DuplicateGroup) {
  return [...group.files].sort(comparePreferredFiles);
}

function getRepresentativeFile(group: DuplicateGroup) {
  return getSortedFiles(group)[0];
}

function getFileIcon(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  if (["jpg", "jpeg", "png", "gif", "bmp", "webp"].includes(ext)) return "🖼️";
  if (["mp4", "mov", "avi", "mkv", "wmv", "flv", "webm"].includes(ext)) return "🎬";
  if (["mp3", "wav", "flac", "aac", "ogg"].includes(ext)) return "🎵";
  if (["pdf"].includes(ext)) return "📄";
  if (["doc", "docx"].includes(ext)) return "📝";
  if (["xls", "xlsx"].includes(ext)) return "📊";
  if (["zip", "rar", "7z", "tar", "gz"].includes(ext)) return "📦";
  return "📁";
}

function isPreviewable(name: string) {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  return ["jpg", "jpeg", "png", "gif", "bmp", "webp", "mp4", "mov", "avi", "mkv", "wmv", "flv", "webm"].includes(ext);
}

export default function Dedup({ active = true }: { active?: boolean }) {
  const [result, setResult] = useState<DedupResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [selectedPath, setSelectedPath] = useState("");
  const [progress, setProgress] = useState<DedupProgress | null>(null);
  const [stepSnapshot, setStepSnapshot] = useState<DedupStepSnapshot>(createEmptyStepSnapshot);
  const [groupThumbnails, setGroupThumbnails] = useState<Map<string, string>>(new Map());
  const [fileThumbnails, setFileThumbnails] = useState<Map<string, string>>(new Map());
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [useTrash, setUseTrash] = useState(true);
  const [scope, setScope] = useState<DedupScope>("all");
  const [verifyBeforeDelete, setVerifyBeforeDelete] = useState(false);
  const [deleteFailures, setDeleteFailures] = useState<DeleteFailure[]>([]);
  const pendingGroupThumbnails = useRef(new Set<string>());
  const pendingFileThumbnails = useRef(new Set<string>());
  const currentTaskIdRef = useRef<string | null>(null);
  const itemHeightsRef = useRef<Map<string, number>>(new Map());
  const itemObserversRef = useRef<Map<string, ResizeObserver>>(new Map());
  const listContainerRef = useRef<HTMLDivElement | null>(null);
  const scrollElementRef = useRef<HTMLElement | null>(null);
  const [measureVersion, setMeasureVersion] = useState(0);
  const [viewportState, setViewportState] = useState({
    scrollTop: 0,
    viewportHeight: 0,
    listTop: 0,
  });
  const toast = useToast();
  const fileActions = useFileActions();
  const task = useTaskReporter("dedup");

  function attachMeasuredNode(hash: string) {
    return (node: HTMLDivElement | null) => {
      const existing = itemObserversRef.current.get(hash);
      if (existing) {
        existing.disconnect();
        itemObserversRef.current.delete(hash);
      }

      if (!node) return;

      const measure = () => {
        const nextHeight = node.offsetHeight;
        const previousHeight = itemHeightsRef.current.get(hash);
        if (previousHeight !== nextHeight) {
          itemHeightsRef.current.set(hash, nextHeight);
          setMeasureVersion((current) => current + 1);
        }
      };

      measure();

      const observer = new ResizeObserver(() => {
        measure();
      });
      observer.observe(node);
      itemObserversRef.current.set(hash, observer);
    };
  }

  function updateViewport() {
    const scrollElement =
      scrollElementRef.current ??
      document.querySelector<HTMLElement>("[data-main-scroll='true']");
    const listElement = listContainerRef.current;

    if (!scrollElement || !listElement) return;

    scrollElementRef.current = scrollElement;

    const scrollRect = scrollElement.getBoundingClientRect();
    const listRect = listElement.getBoundingClientRect();

    setViewportState((prev) => {
      const next = {
        scrollTop: scrollElement.scrollTop,
        viewportHeight: scrollElement.clientHeight,
        listTop: scrollElement.scrollTop + listRect.top - scrollRect.top,
      };

      if (
        prev.scrollTop === next.scrollTop &&
        prev.viewportHeight === next.viewportHeight &&
        prev.listTop === next.listTop
      ) {
        return prev;
      }

      return next;
    });
  }

  useEffect(() => {
    if (!active) return;

    return safeListen<DedupProgress>("dedup-progress", (event) => {
      if (event.payload.task_id !== currentTaskIdRef.current) return;

      setStepSnapshot((prev) => {
        const next = { ...prev };
        switch (event.payload.stage) {
          case "扫描文件":
            next.scannedFiles = Math.max(next.scannedFiles, event.payload.current);
            break;
          case "初步筛选重复文件":
            next.sampleCurrent = Math.max(next.sampleCurrent, event.payload.current);
            next.sampleTotal = Math.max(next.sampleTotal, event.payload.total);
            break;
          case "确认重复文件":
            next.confirmCurrent = Math.max(next.confirmCurrent, event.payload.current);
            next.confirmTotal = Math.max(next.confirmTotal, event.payload.total);
            break;
          default:
            break;
        }
        return next;
      });

      setProgress((prev) => {
        const prevOrder = prev ? DEDUP_STAGE_ORDER[prev.stage] ?? 0 : -1;
        const nextOrder = DEDUP_STAGE_ORDER[event.payload.stage] ?? 0;

        if (prev && prev.task_id === event.payload.task_id && nextOrder < prevOrder) {
          return prev;
        }

        if (
          prev &&
          prev.task_id === event.payload.task_id &&
          prev.stage === event.payload.stage &&
          (event.payload.current < prev.current || event.payload.percent < prev.percent)
        ) {
          return prev;
        }
        return event.payload;
      });
    });
  }, [active]);

  useEffect(() => {
    if (!active) return;

    const scrollElement =
      document.querySelector<HTMLElement>("[data-main-scroll='true']");
    if (!scrollElement) return;

    scrollElementRef.current = scrollElement;

    let frame = 0;
    const onScrollOrResize = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        updateViewport();
      });
    };

    updateViewport();
    scrollElement.addEventListener("scroll", onScrollOrResize, { passive: true });
    window.addEventListener("resize", onScrollOrResize);

    return () => {
      window.cancelAnimationFrame(frame);
      scrollElement.removeEventListener("scroll", onScrollOrResize);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    updateViewport();
  }, [active, result, expandedGroups, loading, measureVersion]);

  useEffect(() => {
    return () => {
      itemObserversRef.current.forEach((observer) => observer.disconnect());
      itemObserversRef.current.clear();
    };
  }, []);

  async function loadGroupThumbnail(hash: string, path: string) {
    if (groupThumbnails.has(hash) || pendingGroupThumbnails.current.has(hash)) return;
    pendingGroupThumbnails.current.add(hash);
    try {
      const thumb = await invoke<string>("get_file_thumbnail", { path });
      setGroupThumbnails((prev) => new Map(prev).set(hash, thumb));
    } catch {
      setGroupThumbnails((prev) => new Map(prev).set(hash, ""));
    } finally {
      pendingGroupThumbnails.current.delete(hash);
    }
  }

  async function loadFileThumbnail(path: string) {
    if (fileThumbnails.has(path) || pendingFileThumbnails.current.has(path)) return;
    pendingFileThumbnails.current.add(path);
    try {
      const thumb = await invoke<string>("get_file_thumbnail", { path });
      setFileThumbnails((prev) => new Map(prev).set(path, thumb));
    } catch {
      setFileThumbnails((prev) => new Map(prev).set(path, ""));
    } finally {
      pendingFileThumbnails.current.delete(path);
    }
  }

  function applyResult(nextResult: DedupResult) {
    startTransition(() => {
      setResult(nextResult);
    });
  }

  async function handleSelect(path: string) {
    if (loading) return;
    const taskId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    currentTaskIdRef.current = taskId;

    flushSync(() => {
      setSelectedPath(path);
      setLoading(true);
      setResult(null);
      setSelected(new Set());
      setExpandedGroups(new Set());
      setStepSnapshot(createEmptyStepSnapshot());
      setDeleteFailures([]);
      itemHeightsRef.current.clear();
      setMeasureVersion((current) => current + 1);
      setProgress({
        task_id: taskId,
        stage: "准备扫描文件夹",
        current: 0,
        total: 0,
        percent: 0,
      });
      setGroupThumbnails(new Map());
      setFileThumbnails(new Map());
      setPreviewImage(null);
      pendingGroupThumbnails.current.clear();
      pendingFileThumbnails.current.clear();
    });

    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });

    try {
      const res = await invoke<DedupResult>("find_duplicates", { path, taskId, scope });
      if (currentTaskIdRef.current !== taskId) return;
      applyResult(res);
    } catch (e) {
      if (currentTaskIdRef.current !== taskId) return;
      console.error(e);
      if (!String(e).includes("取消")) {
        toast.error("扫描失败: " + e);
      }
    } finally {
      if (currentTaskIdRef.current !== taskId) return;
      setLoading(false);
      setProgress(null);
    }
  }

  function toggleSelect(path: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function autoSelect() {
    if (!result) return;
    const toDelete = new Set<string>();
    result.groups.forEach((group) => {
      const sorted = getSortedFiles(group);
      sorted.slice(1).forEach((file) => toDelete.add(file.path));
    });
    const sameSelection =
      selected.size === toDelete.size &&
      Array.from(toDelete).every((path) => selected.has(path));

    setSelected(sameSelection ? new Set() : toDelete);
  }

  function toggleGroup(hash: string) {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(hash)) next.delete(hash);
      else next.add(hash);
      return next;
    });
  }

  async function deleteSelected() {
    if (selected.size === 0 || !result) return;

    const action = useTrash ? "移到回收站" : "永久删除";
    const confirmed = await confirm(
      `确定要${action}选中的 ${selected.size} 个文件吗？${useTrash ? "" : "\n此操作不可恢复！"}`,
      { title: "确认删除", kind: "warning" }
    );

    if (!confirmed) return;

    try {
      const deleteResult = await invoke<DeleteFilesResult>("delete_files", {
        paths: Array.from(selected),
        useTrash,
        groups: result.groups
          .filter((group) => group.files.some((file) => selected.has(file.path)))
          .map<DeleteGroupInput>((group) => ({
            files: group.files.map((file) => file.path),
          })),
        verifyBeforeDelete,
      });
      const failedSelection = new Set(deleteResult.failed.map((item) => item.path));
      setDeleteFailures(deleteResult.failed);

      if (deleteResult.deleted_count > 0 && deleteResult.failed.length === 0) {
        toast.success(`成功${useTrash ? "移到回收站" : "删除"} ${deleteResult.deleted_count} 个文件`);
      } else if (deleteResult.deleted_count > 0) {
        toast.warning(
          `已${useTrash ? "移到回收站" : "删除"} ${deleteResult.deleted_count} 个文件，${deleteResult.failed.length} 个未处理`
        );
      } else {
        toast.error(`未能${useTrash ? "移到回收站" : "删除"}任何文件`);
      }

      if (selectedPath && deleteResult.deleted_count > 0) {
        const taskId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        currentTaskIdRef.current = taskId;
        flushSync(() => {
          setLoading(true);
          setStepSnapshot(createEmptyStepSnapshot());
          itemHeightsRef.current.clear();
          setMeasureVersion((current) => current + 1);
          setProgress({
            task_id: taskId,
            stage: "准备扫描文件夹",
            current: 0,
            total: 0,
            percent: 0,
          });
          setGroupThumbnails(new Map());
          setFileThumbnails(new Map());
          pendingGroupThumbnails.current.clear();
          pendingFileThumbnails.current.clear();
        });
        const res = await invoke<DedupResult>("find_duplicates", { path: selectedPath, taskId, scope });
        if (currentTaskIdRef.current !== taskId) return;
        applyResult(res);
        const remainingFailed = new Set(
          res.groups
            .flatMap((group) => group.files.map((file) => file.path))
            .filter((path) => failedSelection.has(path))
        );
        setSelected(remainingFailed);
        setExpandedGroups(
          new Set(
            res.groups
              .filter((group) => group.files.some((file) => remainingFailed.has(file.path)))
              .map((group) => group.hash)
          )
        );
      } else {
        setSelected(failedSelection);
      }
    } catch (e) {
      toast.error("删除失败: " + e);
    } finally {
      setLoading(false);
      setProgress(null);
    }
  }

  async function cancelScan() {
    const taskId = currentTaskIdRef.current;
    if (!taskId) return;

    try {
      await invoke("cancel_dedup", { taskId });
      currentTaskIdRef.current = null;
      setLoading(false);
      setProgress(null);
      setStepSnapshot(createEmptyStepSnapshot());
      toast.info("已取消扫描");
    } catch (e) {
      console.error(e);
      toast.error("取消失败: " + e);
    }
  }

  useEffect(() => {
    if (!loading) {
      task.clearTask();
      return;
    }

    task.reportTask({
      title: "文件去重",
      stage: progress?.stage || "扫描文件夹",
      detail:
        progress
          ? getDedupProgressText(progress)
          : selectedPath || "等待扫描",
      progress: progress && progress.total > 0 ? progress.percent : undefined,
      cancellable: true,
      onCancel: cancelScan,
    });
  }, [loading, progress, selectedPath]);

  const virtualState = useMemo(() => {
    const groups = result?.groups ?? [];
    let offset = 0;
    const items: VirtualItem[] = groups.map((group, index) => {
      const expanded = expandedGroups.has(group.hash);
      const height = itemHeightsRef.current.get(group.hash) ?? estimateGroupHeight(group, expanded);
      const item = { group, index, top: offset, height };
      offset += height;
      return item;
    });

    const viewportHeight = viewportState.viewportHeight || 1200;
    const visibleTop = Math.max(0, viewportState.scrollTop - viewportState.listTop - VIRTUAL_OVERSCAN);
    const visibleBottom = Math.max(visibleTop, viewportState.scrollTop - viewportState.listTop + viewportHeight + VIRTUAL_OVERSCAN);

    const visibleItems = items.filter(
      (item) => item.top + item.height >= visibleTop && item.top <= visibleBottom
    );

    return {
      totalHeight: offset,
      visibleItems,
    };
  }, [result, expandedGroups, viewportState, measureVersion]);

  const visibleGroups = virtualState.visibleItems.map((item) => item.group);

  useEffect(() => {
    if (!result) return;

    const groups = result.groups;
    let cancelled = false;

    async function preloadInitialGroupThumbnails() {
      const candidates = groups
        .map((group) => ({ group, file: getRepresentativeFile(group) }))
        .filter(({ file }) => isPreviewable(file.name))
        .slice(0, 12);

      for (const { group, file } of candidates) {
        if (cancelled) return;
        await loadGroupThumbnail(group.hash, file.path);
      }
    }

    void preloadInitialGroupThumbnails();

    return () => {
      cancelled = true;
    };
  }, [result]);

  useEffect(() => {
    if (!active || !result) return;

    const groups = result.groups;
    let cancelled = false;

    async function preloadExpandedFileThumbnails() {
      const candidates = groups
        .filter((group) => expandedGroups.has(group.hash))
        .flatMap((group) => getSortedFiles(group))
        .filter((file) => isPreviewable(file.name))
        .filter((file) => !fileThumbnails.has(file.path))
        .slice(0, 24);

      for (const file of candidates) {
        if (cancelled) return;
        await loadFileThumbnail(file.path);
      }
    }

    void preloadExpandedFileThumbnails();

    return () => {
      cancelled = true;
    };
  }, [active, result, expandedGroups, fileThumbnails]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;

    async function warmVisibleGroupThumbnails() {
      const candidates = visibleGroups
        .map((group) => ({ group, file: getRepresentativeFile(group) }))
        .filter(({ file }) => isPreviewable(file.name))
        .filter(({ group }) => !groupThumbnails.has(group.hash))
        .slice(0, 8);

      for (const { group, file } of candidates) {
        if (cancelled) return;
        await loadGroupThumbnail(group.hash, file.path);
      }
    }

    void warmVisibleGroupThumbnails();

    return () => {
      cancelled = true;
    };
  }, [active, visibleGroups, groupThumbnails]);

  return (
    <div className="space-y-6 p-6">
      <DropZone onSelect={handleSelect} loading={loading} selectedPath={selectedPath} active={active} />

      <div className="flex items-center gap-3">
        <Badge tone="default">去重范围</Badge>
        <Button
          variant={scope === "media" ? "primary" : "secondary"}
          size="sm"
          disabled={loading}
          onClick={() => setScope("media")}
        >
          媒体
        </Button>
        <Button
          variant={scope === "all" ? "primary" : "secondary"}
          size="sm"
          disabled={loading}
          onClick={() => setScope("all")}
        >
          全部文件
        </Button>
      </div>

      {loading && progress && (
        <Card>
          <CardContent className="space-y-4 px-5 py-5">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-sm font-medium text-slate-900">文件去重进行中</div>
              </div>
              <div className="flex items-center gap-2">
                <Badge tone="info">{progress.stage}</Badge>
                <Badge tone="warning">进行中</Badge>
              </div>
            </div>
            <div className="space-y-2 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
              {[
                {
                  stage: "扫描文件",
                  title: "Step 1 扫描文件",
                  detail: stepSnapshot.scannedFiles > 0 ? `${stepSnapshot.scannedFiles.toLocaleString()} 个文件` : "等待开始",
                },
                {
                  stage: "初步筛选重复文件",
                  title: "Step 2 初步筛选",
                  detail:
                    stepSnapshot.sampleTotal > 0
                      ? `${stepSnapshot.sampleCurrent.toLocaleString()} / ${stepSnapshot.sampleTotal.toLocaleString()}`
                      : "等待开始",
                },
                {
                  stage: "确认重复文件",
                  title: "Step 3 确认重复",
                  detail:
                    stepSnapshot.confirmTotal > 0
                      ? `${stepSnapshot.confirmCurrent.toLocaleString()} / ${stepSnapshot.confirmTotal.toLocaleString()}`
                      : "等待开始",
                },
              ].map((step) => {
                const status = getStepStatus(progress.stage, step.stage);
                const progressState =
                  step.stage === "扫描文件"
                    ? getStepProgress(progress.stage, step.stage, stepSnapshot.scannedFiles, 0)
                    : step.stage === "初步筛选重复文件"
                      ? getStepProgress(progress.stage, step.stage, stepSnapshot.sampleCurrent, stepSnapshot.sampleTotal)
                      : getStepProgress(progress.stage, step.stage, stepSnapshot.confirmCurrent, stepSnapshot.confirmTotal);
                return (
                  <div key={step.stage} className="space-y-2">
                    <div className="flex items-center justify-between gap-4">
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-slate-900">{step.title}</div>
                        <div className="text-xs text-slate-500">{step.detail}</div>
                      </div>
                      <Badge
                        tone={status === "done" ? "success" : status === "active" ? "info" : "default"}
                      >
                        {status === "done" ? "完成" : status === "active" ? "进行中" : "等待"}
                      </Badge>
                    </div>
                    <Progress value={progressState.value} indeterminate={progressState.indeterminate} />
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {result && (
        <>
          {result.skipped_files > 0 && (
            <Card className="border-amber-100 bg-gradient-to-br from-amber-50/80 to-white">
              <CardContent className="space-y-4 px-5 py-5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-amber-900">部分文件未参与去重</div>
                    <div
                      className="mt-1 truncate text-sm text-amber-800/80"
                      title={`已跳过 ${result.skipped_files.toLocaleString()} 个文件，其中无法读取 ${result.unreadable_files.toLocaleString()} 个，权限不足 ${result.permission_denied_files.toLocaleString()} 个，哈希失败 ${result.hash_failed_files.toLocaleString()} 个。结果可能不完整。`}
                    >
                      已跳过 {result.skipped_files.toLocaleString()} 个文件，其中无法读取{" "}
                      {result.unreadable_files.toLocaleString()} 个，权限不足{" "}
                      {result.permission_denied_files.toLocaleString()} 个，哈希失败{" "}
                      {result.hash_failed_files.toLocaleString()} 个。结果可能不完整。
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Badge tone="warning">跳过 {result.skipped_files.toLocaleString()}</Badge>
                    {result.permission_denied_files > 0 && (
                      <Badge tone="warning">权限不足 {result.permission_denied_files.toLocaleString()}</Badge>
                    )}
                  </div>
                </div>

                {result.sample_errors.length > 0 && (
                  <div className="space-y-2 rounded-[18px] bg-white/80 px-4 py-4 ring-1 ring-amber-100">
                    {result.sample_errors.map((item) => (
                      <div key={`${item.path}-${item.reason}`} className="text-sm text-slate-700">
                        <div className="font-medium text-slate-900">{item.path}</div>
                        <div className="mt-1 text-slate-500">{item.reason}</div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {result.groups.length === 0 ? (
            <EmptyState
              icon="✅"
              title="没有发现重复文件"
              description={
                result.skipped_files > 0
                  ? `这次没有确认出重复文件，但有 ${result.skipped_files.toLocaleString()} 个文件未参与去重，请先看上方提示。`
                  : undefined
              }
            />
          ) : (
            <>
              <Card className="bg-[linear-gradient(135deg,rgba(255,255,255,0.96),rgba(245,248,255,0.92))]">
            <CardContent className="px-5 py-4">
              <div className="overflow-x-auto">
                <div className="flex min-w-max items-center gap-3 whitespace-nowrap text-sm text-slate-600">
                  <span className="text-xs font-medium uppercase tracking-[0.18em] text-slate-400">概览</span>
                  <span>
                    重复分组 <span className="font-semibold text-slate-900">{result.total_groups.toLocaleString()}</span>
                  </span>
                  <span className="text-slate-300">/</span>
                  <span>
                    重复文件 <span className="font-semibold text-slate-900">{result.total_duplicates.toLocaleString()}</span>
                  </span>
                  <span className="text-slate-300">/</span>
                  <span>
                    预计释放 <span className="font-semibold text-slate-900">{formatSize(result.wasted_size)}</span>
                  </span>
                  {result.skipped_files > 0 && (
                    <>
                      <span className="text-slate-300">/</span>
                      <span>
                        跳过 <span className="font-semibold text-amber-700">{result.skipped_files.toLocaleString()}</span>
                      </span>
                    </>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="min-w-0">
                <CardTitle>清理操作</CardTitle>
                <div
                  className="mt-1 truncate text-sm text-slate-500"
                  title={
                    verifyBeforeDelete
                      ? "当前已开启删除前完整校验，只删除与保留文件完全一致的副本。"
                      : "当前默认直接删除，速度更快；如需更稳妥，可开启删除前完整校验。"
                  }
                >
                  {verifyBeforeDelete ? "删除前会先做完整校验。" : "默认直接删除，速度更快。"}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-2 text-sm text-slate-600">
                  <input type="checkbox" checked={useTrash} onChange={(e) => setUseTrash(e.target.checked)} />
                  移到回收站
                </label>
                <label className="flex items-center gap-2 text-sm text-slate-600">
                  <Switch checked={verifyBeforeDelete} onCheckedChange={setVerifyBeforeDelete} />
                  删除前完整校验
                </label>
                <Button variant="secondary" onClick={autoSelect}>
                  智能选择
                </Button>
                <Button variant="danger" onClick={deleteSelected} disabled={selected.size === 0}>
                  删除选中 ({selected.size})
                </Button>
              </div>
            </CardHeader>
            {deleteFailures.length > 0 && (
              <CardContent className="border-t border-amber-100 bg-amber-50/70 px-5 py-4">
                <div className="text-sm text-amber-900">
                  有 {deleteFailures.length} 个文件未处理，通常是权限不足、文件被占用或已不存在。
                </div>
                <div className="mt-2 space-y-1 text-xs text-amber-800/80">
                  {deleteFailures.slice(0, 3).map((item) => (
                    <div key={`${item.path}-${item.reason}`} className="truncate" title={`${item.path} · ${item.reason}`}>
                      {item.path} · {item.reason}
                    </div>
                  ))}
                </div>
              </CardContent>
            )}
          </Card>

          <div ref={listContainerRef} className="relative" style={{ height: `${virtualState.totalHeight}px` }}>
            {virtualState.visibleItems.map((item) => {
              const group = item.group;
              const idx = item.index;
              const sortedFiles = getSortedFiles(group);
              const representativeFile = sortedFiles[0];
              const groupThumb = groupThumbnails.get(group.hash);
              const hasGroupThumb = groupThumbnails.has(group.hash);
              const previewable = isPreviewable(representativeFile.name);
              const expanded = expandedGroups.has(group.hash);

              return (
                <div
                  key={group.hash}
                  ref={attachMeasuredNode(group.hash)}
                  className="absolute left-0 right-0 pb-4"
                  style={{ top: `${item.top}px` }}
                >
                <Card
                  className="overflow-hidden"
                  onMouseEnter={() => {
                    if (previewable) {
                      void loadGroupThumbnail(group.hash, representativeFile.path);
                    }
                  }}
                >
                  <CardHeader className="cursor-pointer bg-slate-50/85" onClick={() => toggleGroup(group.hash)}>
                    <div className="flex min-w-0 items-center gap-4">
                      {previewable ? (
                        <div
                          className="flex h-16 w-16 flex-shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-2xl bg-slate-200"
                          onClick={(event) => {
                            event.stopPropagation();
                            if (groupThumb) setPreviewImage(groupThumb);
                          }}
                        >
                          {groupThumb ? (
                            <img src={groupThumb} alt="" className="h-full w-full object-cover" />
                          ) : (
                            <div className="text-center text-xs text-slate-400">
                              <div className="text-lg">{getFileIcon(representativeFile.name)}</div>
                              <div>{hasGroupThumb ? "暂无封面" : "加载封面"}</div>
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="flex h-16 w-16 flex-shrink-0 items-center justify-center rounded-2xl bg-slate-100 text-2xl">
                          {getFileIcon(representativeFile.name)}
                        </div>
                      )}
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <CardTitle className="text-[15px]">第 {idx + 1} 组</CardTitle>
                          <Badge tone="default">{group.files.length} 个文件</Badge>
                          <Badge tone={expanded ? "info" : "default"}>{expanded ? "收起" : "展开"}</Badge>
                        </div>
                        <div className="mt-1 truncate text-sm text-slate-500">{representativeFile.name}</div>
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                          <span>{formatSize(group.size)} / 文件</span>
                          <span>哈希片段 {group.hash.slice(0, 10)}</span>
                        </div>
                      </div>
                    </div>
                    <Badge tone="warning">预计释放 {formatSize(group.size * (group.files.length - 1))}</Badge>
                  </CardHeader>
                  {expanded && (
                  <CardContent className="space-y-2 px-3 py-3">
                    {sortedFiles.map((file, fileIdx) => (
                      <div
                        key={file.path}
                        onClick={() => toggleSelect(file.path)}
                        onMouseEnter={() => {
                          if (isPreviewable(file.name)) {
                            void loadFileThumbnail(file.path);
                          }
                        }}
                        className={cn(
                          "flex cursor-pointer items-center gap-3 rounded-2xl border px-3 py-3 transition",
                          selected.has(file.path)
                            ? "border-rose-200 bg-rose-50"
                            : "border-transparent bg-slate-50/80 hover:border-slate-200 hover:bg-white"
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={selected.has(file.path)}
                          onClick={(event) => event.stopPropagation()}
                          onChange={() => toggleSelect(file.path)}
                          className="h-4 w-4 rounded"
                        />
                        {isPreviewable(file.name) ? (
                          <div
                            className="flex h-11 w-11 flex-shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-xl bg-slate-100 text-xl"
                            onClick={(event) => {
                              event.stopPropagation();
                              const thumb = fileThumbnails.get(file.path);
                              if (thumb) setPreviewImage(thumb);
                              else void loadFileThumbnail(file.path);
                            }}
                          >
                            {fileThumbnails.get(file.path) ? (
                              <img src={fileThumbnails.get(file.path)} alt="" className="h-full w-full object-cover" />
                            ) : (
                              <div className="text-center text-[10px] text-slate-400">
                                <div className="text-base">{getFileIcon(file.name)}</div>
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl bg-slate-100 text-xl">
                            {getFileIcon(file.name)}
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-slate-900">{file.name}</div>
                          <div className="truncate text-xs text-slate-500">{file.path}</div>
                          <div className="mt-1 text-xs text-slate-400">
                            创建 {formatDate(file.created)} · 修改 {formatDate(file.modified)}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={(event) => {
                              event.stopPropagation();
                              void fileActions.openFile(file.path);
                            }}
                          >
                            打开
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={(event) => {
                              event.stopPropagation();
                              void fileActions.revealInDir(file.path);
                            }}
                          >
                            位置
                          </Button>
                        </div>
                        {fileIdx === 0 && <Badge tone="success">建议保留</Badge>}
                      </div>
                    ))}
                  </CardContent>
                  )}
                </Card>
                </div>
              );
            })}
          </div>
            </>
          )}
        </>
      )}

      <Modal open={Boolean(previewImage)} onClose={() => setPreviewImage(null)} className="max-w-5xl overflow-hidden bg-slate-950">
        <div className="relative flex max-h-[88vh] items-center justify-center bg-slate-950 p-5">
          {previewImage && (
            <img src={previewImage} alt="预览" className="max-h-[80vh] max-w-full rounded-2xl object-contain" />
          )}
          <button
            className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-full bg-white/90 text-slate-700 transition hover:bg-white"
            onClick={() => setPreviewImage(null)}
          >
            ✕
          </button>
        </div>
      </Modal>
    </div>
  );
}
