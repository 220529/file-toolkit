import type { DedupProgress, DedupResult, DeleteFailure } from "../../api/tauri";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Checkbox } from "../../components/ui/checkbox";
import { Progress } from "../../components/ui/progress";
import { formatSize } from "../../utils/format";
import {
  getStepProgress,
  getStepStatus,
  type DedupStepSnapshot,
} from "./utils";

export function DedupProgressCard({
  progress,
  stepSnapshot,
}: {
  progress: DedupProgress;
  stepSnapshot: DedupStepSnapshot;
}) {
  const steps = [
    {
      stage: "扫描文件",
      title: "Step 1 扫描文件",
      detail: stepSnapshot.scannedFiles > 0 ? `${stepSnapshot.scannedFiles.toLocaleString()} 个文件` : "等待开始",
    },
    {
      stage: "初步筛选重复文件",
      title: "Step 2 筛选候选",
      detail:
        stepSnapshot.sampleTotal > 0
          ? `${stepSnapshot.sampleCurrent.toLocaleString()} / ${stepSnapshot.sampleTotal.toLocaleString()}`
          : "等待开始",
    },
    {
      stage: "确认重复文件",
      title: "Step 3 完整确认",
      detail:
        stepSnapshot.confirmTotal > 0
          ? `${stepSnapshot.confirmCurrent.toLocaleString()} / ${stepSnapshot.confirmTotal.toLocaleString()}`
          : "等待开始",
    },
  ];

  return (
    <Card>
      <CardContent className="space-y-4 px-5 py-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-sm font-semibold text-[var(--text-strong)]">文件去重进行中</div>
            <div className="mt-1 text-xs text-[var(--text-muted)]">
              {progress.detail || "先缩小候选范围，最后用完整哈希确认重复"}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge tone="info">{progress.stage}</Badge>
            <Badge tone="warning">进行中</Badge>
          </div>
        </div>
        <div className="grid gap-2 lg:grid-cols-3">
          {steps.map((step) => {
            const status = getStepStatus(progress.stage, step.stage);
            const progressState =
              step.stage === "扫描文件"
                ? getStepProgress(progress.stage, step.stage, stepSnapshot.scannedFiles, 0)
                : step.stage === "初步筛选重复文件"
                  ? getStepProgress(progress.stage, step.stage, stepSnapshot.sampleCurrent, stepSnapshot.sampleTotal)
                  : getStepProgress(progress.stage, step.stage, stepSnapshot.confirmCurrent, stepSnapshot.confirmTotal);
            return (
              <div key={step.stage} className="space-y-2 rounded-[8px] border border-[var(--stroke)] bg-[#f7f8f5] px-3 py-3">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-[var(--text-strong)]">{step.title}</div>
                    <div className="text-xs text-[var(--text-muted)]">{step.detail}</div>
                  </div>
                  <Badge tone={status === "done" ? "success" : status === "active" ? "info" : "default"}>
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
  );
}

export function DedupSkippedFilesNotice({ result }: { result: DedupResult }) {
  if (result.skipped_files <= 0) return null;

  return (
    <Card className="border-[rgba(177,106,37,0.2)] bg-[#fff8ea]">
      <CardContent className="space-y-4 px-5 py-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-[#7a4516]">部分文件未参与去重</div>
            <div
              className="mt-1 truncate text-sm text-[#8a5b25]"
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
          <div className="space-y-2 rounded-[8px] bg-white/80 px-4 py-4 ring-1 ring-[rgba(177,106,37,0.14)]">
            {result.sample_errors.map((item) => (
              <div key={`${item.path}-${item.reason}`} className="text-sm text-[var(--text-muted)]">
                <div className="font-medium text-[var(--text-strong)]">{item.path}</div>
                <div className="mt-1 text-[var(--text-muted)]">{item.reason}</div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function DedupSummaryCard({ result }: { result: DedupResult }) {
  const metrics = [
    { label: "重复分组", value: result.total_groups.toLocaleString(), tone: "text-[var(--text-strong)]" },
    { label: "重复文件", value: result.total_duplicates.toLocaleString(), tone: "text-[var(--text-strong)]" },
    { label: "预计释放", value: formatSize(result.wasted_size), tone: "text-[var(--accent-600)]" },
    { label: "跳过文件", value: result.skipped_files.toLocaleString(), tone: result.skipped_files > 0 ? "text-[var(--warning-600)]" : "text-[var(--text-strong)]" },
  ];

  return (
    <Card className="overflow-hidden">
      <CardContent className="p-0">
        <div className="grid divide-y divide-[var(--stroke)] sm:grid-cols-2 sm:divide-x sm:divide-y-0 xl:grid-cols-4">
          {metrics.map((item) => (
            <div key={item.label} className="px-5 py-4">
              <div className="text-xs font-medium text-[var(--text-muted)]">{item.label}</div>
              <div className={`mt-1 font-mono text-2xl font-semibold ${item.tone}`}>{item.value}</div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export function DedupActionsCard({
  busy,
  deleteFailures,
  onAutoSelect,
  onDeleteSelected,
  onUseTrashChange,
  selectedCount,
  useTrash,
}: {
  busy?: boolean;
  deleteFailures: DeleteFailure[];
  onAutoSelect: () => void;
  onDeleteSelected: () => void;
  onUseTrashChange: (value: boolean) => void;
  selectedCount: number;
  useTrash: boolean;
}) {
  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex-col bg-white md:flex-row md:items-center">
        <div className="min-w-0 flex-1">
          <CardTitle>清理操作</CardTitle>
          <div className="mt-1 text-sm text-[var(--text-muted)]">每组至少保留一份，删除前重新确认内容。</div>
          {busy && <div className="mt-1 text-xs text-[var(--text-muted)]">当前任务处理中，已锁定选择和删除操作。</div>}
        </div>
        <div className="flex w-full flex-col gap-3 md:w-auto md:flex-row md:flex-wrap md:items-center md:justify-end">
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 rounded-[8px] border border-[var(--stroke)] bg-[#f7f8f5] px-3 py-2 text-sm text-[var(--text-muted)]">
              <Checkbox checked={useTrash} disabled={busy} onCheckedChange={(checked) => onUseTrashChange(checked === true)} />
              移到回收站
            </label>
            <Badge tone="success">完整校验已开启</Badge>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" onClick={onAutoSelect} disabled={busy}>
              智能选择
            </Button>
            <Button variant="danger" onClick={onDeleteSelected} disabled={busy || selectedCount === 0}>
              {busy ? "处理中" : `删除选中 (${selectedCount})`}
            </Button>
          </div>
        </div>
      </CardHeader>
      {deleteFailures.length > 0 && (
        <CardContent className="border-t border-[rgba(177,106,37,0.16)] bg-[#fff8ea] px-5 py-4">
          <div className="text-sm text-[#7a4516]">
            有 {deleteFailures.length} 个文件未处理，通常是权限不足、文件被占用或已不存在。
          </div>
          <div className="mt-2 space-y-1 text-xs text-[#8a5b25]">
            {deleteFailures.slice(0, 3).map((item) => (
              <div key={`${item.path}-${item.reason}`} className="truncate" title={`${item.path} · ${item.reason}`}>
                {item.path} · {item.reason}
              </div>
            ))}
          </div>
        </CardContent>
      )}
    </Card>
  );
}
