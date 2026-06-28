import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useState } from "react";
import { batchRename, pathExists, type BatchRenameResult, type RenameOperation } from "../api/tauri";
import { EmptyState } from "../components/ui/empty-state";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Checkbox } from "../components/ui/checkbox";
import { Icon } from "../components/ui/icon";
import { Input } from "../components/ui/input";
import { Modal } from "../components/ui/modal";
import { useTaskReporter } from "../components/TaskCenter";
import { useToast } from "../components/Toast";
import { useWindowDrop } from "../hooks/useWindowDrop";
import { cn } from "../utils/cn";
import type { ExtensionCaseMode, NameCaseMode, RenameRule } from "./batchRename/types";
import {
  buildRenamePreview,
  collectRenameTargetPaths,
  defaultRenameRule,
  hasBlockingPreviewIssue,
  readyRenameOperations,
} from "./batchRename/utils";

interface Props {
  active?: boolean;
}

interface RenameUndoState {
  operations: RenameOperation[];
  count: number;
}

const nameCaseOptions: Array<{ value: NameCaseMode; label: string }> = [
  { value: "keep", label: "保持" },
  { value: "lower", label: "小写" },
  { value: "upper", label: "大写" },
  { value: "title", label: "首字母" },
];

const extensionCaseOptions: Array<{ value: ExtensionCaseMode; label: string }> = [
  { value: "keep", label: "保持" },
  { value: "lower", label: "小写" },
  { value: "upper", label: "大写" },
];

export default function BatchRename({ active = true }: Props) {
  const [paths, setPaths] = useState<string[]>([]);
  const [rule, setRule] = useState<RenameRule>(defaultRenameRule);
  const [renaming, setRenaming] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [lastResult, setLastResult] = useState<BatchRenameResult | null>(null);
  const [undoState, setUndoState] = useState<RenameUndoState | null>(null);
  const [existingTargetPaths, setExistingTargetPaths] = useState<Set<string>>(() => new Set());
  const [checkingTargets, setCheckingTargets] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const toast = useToast();
  const task = useTaskReporter("batch-rename");
  const busy = renaming || undoing;
  const { dragging } = useWindowDrop({
    active,
    onDrop: (nextPaths) => {
      if (busy) return;
      addPaths(nextPaths);
    },
  });

  const basePreviewItems = useMemo(() => buildRenamePreview(paths, rule), [paths, rule]);
  const targetPathsToCheck = useMemo(() => collectRenameTargetPaths(basePreviewItems), [basePreviewItems]);
  const targetCheckKey = useMemo(() => targetPathsToCheck.join("\n"), [targetPathsToCheck]);
  const previewItems = useMemo(
    () => buildRenamePreview(paths, rule, { existingTargetPaths }),
    [existingTargetPaths, paths, rule]
  );
  const readyItems = previewItems.filter((item) => item.status === "ready");
  const blocked = hasBlockingPreviewIssue(previewItems);
  const canRename = readyItems.length > 0 && !blocked && !busy && !checkingTargets;
  const canUndo = Boolean(undoState && undoState.count > 0 && !busy);

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

  function addPaths(nextPaths: string[]) {
    setPaths((current) => {
      const next = [...current];
      const seen = new Set(current);
      for (const path of nextPaths) {
        if (!path || seen.has(path)) continue;
        seen.add(path);
        next.push(path);
      }
      return next;
    });
    setLastResult(null);
  }

  async function chooseFiles() {
    if (busy) return;
    const selected = await open({
      multiple: true,
      directory: false,
      title: "选择要重命名的文件",
    });
    if (Array.isArray(selected)) {
      addPaths(selected);
    } else if (typeof selected === "string") {
      addPaths([selected]);
    }
  }

  function requestRenameConfirmation() {
    if (!canRename) return;
    setConfirmOpen(true);
  }

  async function executeRename() {
    if (!canRename) return;
    setConfirmOpen(false);
    const operations = readyRenameOperations(previewItems);
    setRenaming(true);
    task.reportTask({
      title: "批量重命名",
      stage: "执行重命名",
      detail: `${operations.length} 个文件`,
    });

    try {
      const result = await batchRename({ operations });
      setLastResult(result);
      const successfulItems = result.items.filter((item) => item.ok);
      const renamedMap = new Map(successfulItems.map((item) => [item.from, item.to]));
      setPaths((current) => current.map((path) => renamedMap.get(path) || path));
      setUndoState(buildRenameUndoState(successfulItems));
      toast.success(`已重命名 ${result.renamed} 个文件`);
      task.reportTask({
        title: "批量重命名",
        stage: "重命名完成",
        detail: `${result.renamed}/${result.total} 个文件`,
        progress: 100,
        status: result.failed > 0 ? "error" : "success",
      });
      window.setTimeout(task.clearTask, 1200);
    } catch (error) {
      toast.error("重命名失败: " + error);
      task.reportTask({
        title: "批量重命名",
        stage: "重命名失败",
        detail: String(error),
        progress: 100,
        status: "error",
      });
      window.setTimeout(task.clearTask, 1600);
    } finally {
      setRenaming(false);
    }
  }

  async function undoLastRename() {
    if (!undoState || !canUndo) return;
    setUndoing(true);
    task.reportTask({
      title: "批量重命名",
      stage: "撤销重命名",
      detail: `${undoState.count} 个文件`,
    });

    try {
      const result = await batchRename({ operations: undoState.operations });
      setLastResult(result);
      const restoredMap = new Map(result.items.filter((item) => item.ok).map((item) => [item.from, item.to]));
      setPaths((current) => current.map((path) => restoredMap.get(path) || path));
      setUndoState(buildRetryUndoState(result.items.filter((item) => !item.ok)));
      if (result.failed > 0) {
        toast.warning(`已撤销 ${result.renamed} 个文件，${result.failed} 个失败`);
      } else {
        toast.success(`已撤销 ${result.renamed} 个文件`);
      }
      task.reportTask({
        title: "批量重命名",
        stage: result.failed > 0 ? "撤销部分失败" : "撤销完成",
        detail: `${result.renamed}/${result.total} 个文件`,
        progress: 100,
        status: result.failed > 0 ? "error" : "success",
      });
      window.setTimeout(task.clearTask, result.failed > 0 ? 1600 : 1200);
    } catch (error) {
      toast.error("撤销失败: " + error);
      task.reportTask({
        title: "批量重命名",
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

  function updateRule(patch: Partial<RenameRule>) {
    setRule((current) => ({ ...current, ...patch }));
    setLastResult(null);
  }

  return (
    <div className="mx-auto max-w-[1320px] space-y-3">
      <div className="grid min-h-[calc(100vh-150px)] gap-3 lg:grid-cols-[390px_minmax(0,1fr)]">
        <Card className="overflow-hidden">
          <CardHeader>
            <div>
              <CardTitle>批量重命名</CardTitle>
              <CardDescription className="mt-1">预览确认后再执行，不覆盖已有文件。</CardDescription>
            </div>
            <Button variant="primary" onClick={() => void chooseFiles()} disabled={busy}>
              <Icon name="file" size={15} />
              添加文件
            </Button>
          </CardHeader>
          <CardContent className="space-y-4">
            <div
              onClick={() => void chooseFiles()}
              className={cn(
                "flex min-h-[128px] cursor-pointer flex-col items-center justify-center rounded-[8px] border border-dashed border-slate-300 bg-slate-50 px-4 py-5 text-center transition",
                dragging && active && "border-blue-300 bg-blue-50"
              )}
            >
              <Icon name={dragging ? "folderOpen" : "file"} size={24} className="text-[var(--brand-700)]" />
              <div className="mt-2 text-sm font-semibold text-slate-800">
                {dragging ? "松开以添加文件" : "拖入文件，或点击选择"}
              </div>
              <div className="mt-1 text-xs text-slate-500">已选择 {paths.length} 个文件</div>
            </div>

            <RuleSection title="基础规则">
              <LabeledInput label="前缀" value={rule.prefix} onChange={(value) => updateRule({ prefix: value })} />
              <LabeledInput label="后缀" value={rule.suffix} onChange={(value) => updateRule({ suffix: value })} />
              <div className="grid grid-cols-2 gap-2">
                <LabeledInput label="查找" value={rule.find} onChange={(value) => updateRule({ find: value })} />
                <LabeledInput label="替换为" value={rule.replace} onChange={(value) => updateRule({ replace: value })} />
              </div>
            </RuleSection>

            <RuleSection title="序号">
              <label className="flex items-center gap-2 text-xs font-medium text-slate-700">
                <Checkbox
                  checked={rule.numbering}
                  onCheckedChange={(value) => updateRule({ numbering: value === true })}
                />
                追加递增序号
              </label>
              <div className="grid grid-cols-2 gap-2">
                <LabeledInput
                  label="起始"
                  type="number"
                  value={String(rule.startNumber)}
                  onChange={(value) => updateRule({ startNumber: Number(value) || 0 })}
                />
                <LabeledInput
                  label="位数"
                  type="number"
                  value={String(rule.padding)}
                  onChange={(value) => updateRule({ padding: Number(value) || 1 })}
                />
              </div>
            </RuleSection>

            <RuleSection title="大小写">
              <SegmentedControl
                label="文件名"
                value={rule.nameCase}
                options={nameCaseOptions}
                onChange={(value) => updateRule({ nameCase: value })}
              />
              <SegmentedControl
                label="扩展名"
                value={rule.extensionCase}
                options={extensionCaseOptions}
                onChange={(value) => updateRule({ extensionCase: value })}
              />
            </RuleSection>

            <div className="flex gap-2">
              <Button variant="secondary" className="flex-1" onClick={() => updateRule(defaultRenameRule)}>
                重置规则
              </Button>
              <Button
                variant="ghost"
                className="flex-1"
                onClick={() => {
                  setPaths([]);
                  setUndoState(null);
                }}
                disabled={busy || paths.length === 0}
              >
                清空文件
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="flex min-h-[520px] flex-col overflow-hidden">
          <CardHeader>
            <div>
              <CardTitle>预览</CardTitle>
              <CardDescription className="mt-1">
                {readyItems.length} 个可执行，{previewItems.length - readyItems.length} 个需要处理
                {checkingTargets ? "，正在检查目标路径" : ""}
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              {lastResult && (
                <Badge tone={lastResult.failed > 0 ? "warning" : "success"}>
                  {lastResult.renamed}/{lastResult.total}
                </Badge>
              )}
              {undoState && undoState.count > 0 && (
                <Button variant="secondary" onClick={() => void undoLastRename()} disabled={!canUndo}>
                  <Icon name="reset" size={15} />
                  {undoing ? "撤销中" : "撤销上次"}
                </Button>
              )}
              <Button variant="primary" onClick={requestRenameConfirmation} disabled={!canRename}>
                <Icon name="check" size={15} />
                {renaming ? "执行中" : "执行重命名"}
              </Button>
            </div>
          </CardHeader>
          <CardContent className="min-h-0 flex-1 overflow-auto">
            {previewItems.length === 0 ? (
              <EmptyState
                icon={<Icon name="file" size={24} />}
                title="还没有文件"
                description="添加文件后会在这里预览新旧文件名。"
              />
            ) : (
              <div className="overflow-hidden rounded-[8px] border border-slate-200">
                <div className="grid grid-cols-[minmax(180px,1fr)_minmax(180px,1fr)_92px] border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-500">
                  <div>原文件名</div>
                  <div>新文件名</div>
                  <div className="text-right">状态</div>
                </div>
                <div className="max-h-[calc(100vh-300px)] overflow-auto">
                  {previewItems.map((item) => (
                    <div
                      key={item.path}
                      className="grid grid-cols-[minmax(180px,1fr)_minmax(180px,1fr)_92px] items-center gap-3 border-b border-slate-100 px-3 py-2 last:border-b-0"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-slate-800">{item.originalName}</div>
                        <div className="truncate text-[11px] text-slate-400">{item.directory}</div>
                      </div>
                      <div className="min-w-0">
                        <div className={cn("truncate text-sm font-medium", item.status === "ready" ? "text-slate-900" : "text-amber-700")}>
                          {item.nextName}
                        </div>
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
        accessibleTitle="确认批量重命名"
        className="max-w-xl"
      >
        <div className="space-y-5 p-6">
          <div>
            <CardTitle className="text-xl">确认重命名 {readyItems.length} 个文件？</CardTitle>
            <CardDescription className="mt-2">
              操作会直接修改磁盘上的文件名。当前预览没有冲突，且后端会再次拒绝覆盖已有文件。
            </CardDescription>
          </div>
          <div className="max-h-[260px] overflow-auto rounded-[8px] border border-slate-200">
            {readyItems.slice(0, 8).map((item) => (
              <div key={item.path} className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 border-b border-slate-100 px-3 py-2 text-xs last:border-b-0">
                <div className="truncate text-slate-500">{item.originalName}</div>
                <Icon name="chevronRight" size={14} className="text-slate-400" />
                <div className="truncate font-medium text-slate-900">{item.nextName}</div>
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
            <Button variant="primary" onClick={() => void executeRename()} disabled={busy}>
              {renaming ? "执行中" : "确认执行"}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function buildRenameUndoState(items: Array<{ from: string; to: string; ok: boolean }>): RenameUndoState | null {
  const operations = items
    .filter((item) => item.ok)
    .map((item) => ({ from: item.to, to: item.from }))
    .reverse();

  return createRenameUndoState(operations);
}

function buildRetryUndoState(items: Array<{ from: string; to: string; ok: boolean }>): RenameUndoState | null {
  const operations = items
    .filter((item) => !item.ok)
    .map((item) => ({ from: item.from, to: item.to }));

  return createRenameUndoState(operations);
}

function createRenameUndoState(operations: RenameOperation[]): RenameUndoState | null {
  if (operations.length === 0) return null;
  return { operations, count: operations.length };
}

function RuleSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3 rounded-[8px] border border-slate-200 bg-slate-50 p-3">
      <div className="text-xs font-semibold text-slate-700">{title}</div>
      {children}
    </div>
  );
}

function LabeledInput({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-[11px] font-medium text-slate-500">{label}</label>
      <Input value={value} type={type} onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}

function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="space-y-1.5">
      <div className="text-[11px] font-medium text-slate-500">{label}</div>
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
