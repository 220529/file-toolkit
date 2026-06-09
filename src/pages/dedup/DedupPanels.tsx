import type { DedupProgress, DedupResult, DeleteFailure } from "../../api/tauri";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Checkbox } from "../../components/ui/checkbox";
import { Progress } from "../../components/ui/progress";
import { Switch } from "../../components/ui/switch";
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
  ];

  return (
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
        <div className="space-y-2 rounded-[10px] border border-slate-200 bg-slate-50 px-4 py-4">
          {steps.map((step) => {
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
    <Card className="border-amber-200 bg-amber-50">
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
          <div className="space-y-2 rounded-[10px] bg-white/80 px-4 py-4 ring-1 ring-amber-100">
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
  );
}

export function DedupSummaryCard({ result }: { result: DedupResult }) {
  return (
    <Card>
      <CardContent className="px-5 py-4">
        <div className="overflow-x-auto">
          <div className="flex min-w-max items-center gap-3 whitespace-nowrap text-sm text-slate-600">
            <span className="text-xs font-medium text-slate-400">概览</span>
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
  );
}

export function DedupActionsCard({
  deleteFailures,
  onAutoSelect,
  onDeleteSelected,
  onUseTrashChange,
  onVerifyBeforeDeleteChange,
  selectedCount,
  useTrash,
  verifyBeforeDelete,
}: {
  deleteFailures: DeleteFailure[];
  onAutoSelect: () => void;
  onDeleteSelected: () => void;
  onUseTrashChange: (value: boolean) => void;
  onVerifyBeforeDeleteChange: (value: boolean) => void;
  selectedCount: number;
  useTrash: boolean;
  verifyBeforeDelete: boolean;
}) {
  return (
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
            <Checkbox checked={useTrash} onCheckedChange={(checked) => onUseTrashChange(checked === true)} />
            移到回收站
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <Switch checked={verifyBeforeDelete} onCheckedChange={onVerifyBeforeDeleteChange} />
            删除前完整校验
          </label>
          <Button variant="secondary" onClick={onAutoSelect}>
            智能选择
          </Button>
          <Button variant="danger" onClick={onDeleteSelected} disabled={selectedCount === 0}>
            删除选中 ({selectedCount})
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
  );
}
