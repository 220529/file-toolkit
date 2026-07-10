import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import { flushSync } from "react-dom";
import {
  cancelDedup,
  deleteFiles,
  findDuplicates,
  type DedupProgress,
  type DedupResult,
  type DedupScope,
  type DeleteFailure,
  type DeleteGroupInput,
} from "../api/tauri";
import { useFileActions } from "../hooks/useFileActions";
import DropZone from "../components/DropZone";
import { useTaskReporter } from "../components/TaskCenter";
import { useToast } from "../components/Toast";
import { EmptyState } from "../components/ui/empty-state";
import { Icon } from "../components/ui/icon";
import { safeListen } from "../utils/tauriEvent";
import { createTaskId } from "../utils/id";
import {
  DedupActionsCard,
  DedupProgressCard,
  DedupSkippedFilesNotice,
  DedupSummaryCard,
} from "./dedup/DedupPanels";
import { DedupGroupList } from "./dedup/DedupGroupList";
import { useDedupThumbnails } from "./dedup/useDedupThumbnails";
import { DedupPreviewModal } from "./dedup/DedupPreviewModal";
import {
  DEDUP_STAGE_ORDER,
  VIRTUAL_OVERSCAN,
  createEmptyStepSnapshot,
  estimateGroupHeight,
  getDedupProgressText,
  getRepresentativeFile,
  getSortedFiles,
  isPreviewable,
  type DedupStepSnapshot,
  type VirtualItem,
} from "./dedup/utils";

export default function Dedup({ active = true }: { active?: boolean }) {
  const [result, setResult] = useState<DedupResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [selectedPath, setSelectedPath] = useState("");
  const [progress, setProgress] = useState<DedupProgress | null>(null);
  const [stepSnapshot, setStepSnapshot] = useState<DedupStepSnapshot>(createEmptyStepSnapshot);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [useTrash, setUseTrash] = useState(true);
  const [scope, setScope] = useState<DedupScope>("media");
  const [verifyBeforeDelete, setVerifyBeforeDelete] = useState(false);
  const [deleteFailures, setDeleteFailures] = useState<DeleteFailure[]>([]);
  const [deleting, setDeleting] = useState(false);
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
  const {
    fileThumbnails,
    groupThumbnails,
    loadFileThumbnail,
    loadGroupThumbnail,
    resetThumbnails,
  } = useDedupThumbnails();

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

    return safeListen("dedup-progress", (event) => {
      if (event.payload.task_id !== currentTaskIdRef.current) return;

      setStepSnapshot((prev) => {
        const next = { ...prev };
        switch (event.payload.stage) {
          case "扫描文件":
            next.scannedFiles = Math.max(next.scannedFiles, event.payload.current);
            break;
          case "初步筛选重复文件":
            next.sampleCurrent = event.payload.current;
            next.sampleTotal = event.payload.total;
            break;
          case "确认重复文件":
            next.confirmCurrent = event.payload.current;
            next.confirmTotal = event.payload.total;
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

  function applyResult(nextResult: DedupResult) {
    startTransition(() => {
      setResult(nextResult);
    });
  }

  async function handleSelect(path: string) {
    if (loading) return;
    const taskId = createTaskId("dedup");
    currentTaskIdRef.current = taskId;

    flushSync(() => {
      setSelectedPath(path);
      setLoading(true);
      setDeleting(false);
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
      resetThumbnails();
      setPreviewImage(null);
    });

    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });

    try {
      const res = await findDuplicates(path, taskId, scope);
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
    if (loading || deleting) return;
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function autoSelect() {
    if (!result || loading || deleting) return;
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
    if (deleting) return;
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(hash)) next.delete(hash);
      else next.add(hash);
      return next;
    });
  }

  async function deleteSelected() {
    if (selected.size === 0 || !result || loading || deleting) return;

    const action = useTrash ? "移到回收站" : "永久删除";
    const confirmed = await confirm(
      `确定要${action}选中的 ${selected.size} 个文件吗？${useTrash ? "" : "\n此操作不可恢复！"}`,
      { title: "确认删除", kind: "warning" }
    );

    if (!confirmed) return;

    try {
      setDeleting(true);
      const deleteResult = await deleteFiles({
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
        const taskId = createTaskId("dedup");
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
          resetThumbnails();
        });
        const res = await findDuplicates(selectedPath, taskId, scope);
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
      setDeleting(false);
      setLoading(false);
      setProgress(null);
    }
  }

  async function cancelScan() {
    const taskId = currentTaskIdRef.current;
    if (!taskId) return;

    try {
      await cancelDedup(taskId);
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
    <div className="mx-auto max-w-[1360px] space-y-4 pb-4">
      <DropZone onSelect={handleSelect} loading={loading} selectedPath={selectedPath} active={active} />

      <div className="flex flex-col gap-3 rounded-[8px] border border-[var(--stroke)] bg-white px-4 py-3 shadow-[0_1px_2px_rgba(16,20,23,0.04)] md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-[var(--text-strong)]">去重范围</div>
          <div className="mt-0.5 text-xs text-[var(--text-muted)]">媒体模式会优先过滤图片、视频、音频；全部文件会覆盖更多类型。</div>
        </div>
        <div className="flex w-full rounded-[8px] border border-[var(--stroke)] bg-[#f7f8f5] p-1 md:w-auto">
          <button
            type="button"
            disabled={loading}
            onClick={() => setScope("media")}
            className={`flex-1 rounded-[7px] px-3 py-2 text-sm font-medium transition md:flex-none ${
              scope === "media"
                ? "bg-white text-[var(--brand-700)] shadow-[0_1px_4px_rgba(16,20,23,0.08)]"
                : "text-[var(--text-muted)] hover:text-[var(--text-strong)]"
            } disabled:cursor-not-allowed disabled:opacity-50`}
          >
            媒体
          </button>
          <button
            type="button"
            disabled={loading}
            onClick={() => setScope("all")}
            className={`flex-1 rounded-[7px] px-3 py-2 text-sm font-medium transition md:flex-none ${
              scope === "all"
                ? "bg-white text-[var(--brand-700)] shadow-[0_1px_4px_rgba(16,20,23,0.08)]"
                : "text-[var(--text-muted)] hover:text-[var(--text-strong)]"
            } disabled:cursor-not-allowed disabled:opacity-50`}
          >
            全部文件
          </button>
        </div>
      </div>

      {loading && progress && <DedupProgressCard progress={progress} stepSnapshot={stepSnapshot} />}

      {result && (
        <>
          <DedupSkippedFilesNotice result={result} />

          {result.groups.length === 0 ? (
            <EmptyState
              icon={<Icon name="check" size={28} />}
              title="没有发现重复文件"
              description={
                result.skipped_files > 0
                  ? `这次没有确认出重复文件，但有 ${result.skipped_files.toLocaleString()} 个文件未参与去重，请先看上方提示。`
                  : undefined
              }
            />
          ) : (
            <>
              <DedupSummaryCard result={result} />

              <DedupActionsCard
                busy={loading || deleting}
                deleteFailures={deleteFailures}
                onAutoSelect={autoSelect}
                onDeleteSelected={() => void deleteSelected()}
                onUseTrashChange={setUseTrash}
                onVerifyBeforeDeleteChange={setVerifyBeforeDelete}
                selectedCount={selected.size}
                useTrash={useTrash}
                verifyBeforeDelete={verifyBeforeDelete}
              />

              <DedupGroupList
                expandedGroups={expandedGroups}
                fileThumbnails={fileThumbnails}
                groupThumbnails={groupThumbnails}
                listContainerRef={listContainerRef}
                onAttachMeasuredNode={attachMeasuredNode}
                onLoadFileThumbnail={loadFileThumbnail}
                onLoadGroupThumbnail={loadGroupThumbnail}
                onOpenFile={fileActions.openFile}
                onPreviewImage={setPreviewImage}
                onRevealInDir={fileActions.revealInDir}
                onToggleGroup={toggleGroup}
                onToggleSelect={toggleSelect}
                selected={selected}
                selectionLocked={loading || deleting}
                totalHeight={virtualState.totalHeight}
                visibleItems={virtualState.visibleItems}
              />
            </>
          )}
        </>
      )}

      <DedupPreviewModal image={previewImage} onClose={() => setPreviewImage(null)} />
    </div>
  );
}
