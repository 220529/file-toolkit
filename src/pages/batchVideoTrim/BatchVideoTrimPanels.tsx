import type { BatchTrimProgress, BatchTrimResult, BatchVideoFile, VideoInfo } from "../../api/tauri";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Icon } from "../../components/ui/icon";
import { Input } from "../../components/ui/input";
import { Progress } from "../../components/ui/progress";
import { Switch } from "../../components/ui/switch";
import { cn } from "../../utils/cn";
import { formatSize } from "../../utils/format";
import { getBaseName } from "../../utils/path";
import {
  clamp,
  formatTime,
  getProgressText,
  parseTimeInput,
  type OutputMode,
} from "./utils";

export function BatchVideoDropCard({
  dragging,
  onSelectFiles,
  onSelectFolder,
  processing,
}: {
  dragging: boolean;
  onSelectFiles: () => void;
  onSelectFolder: () => void;
  processing: boolean;
}) {
  return (
    <Card className="overflow-hidden">
      <CardContent className="px-5 py-5">
        <div
          className={cn(
            "drop-zone flex flex-col items-center justify-center",
            dragging && "dragging",
            processing && "pointer-events-none opacity-70"
          )}
          onClick={onSelectFiles}
        >
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-[8px] border border-slate-200 bg-slate-50 text-[var(--brand-700)]">
            <Icon name={dragging ? "folderOpen" : "video"} size={30} />
          </div>
          <div className="text-lg font-semibold text-slate-900">
            {dragging ? "松开以载入素材" : "拖入视频或文件夹，或点击选择视频"}
          </div>
          <div className="mt-2 text-sm text-slate-500">适合一批拥有相同片头的视频，统一删除前 X 秒。</div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={(event) => {
                event.stopPropagation();
                onSelectFiles();
              }}
              disabled={processing}
            >
              选择视频
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={(event) => {
                event.stopPropagation();
                onSelectFolder();
              }}
              disabled={processing}
            >
              选择文件夹
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function BatchVideoSummaryCard({
  filesCount,
  reviewedCount,
  samplePath,
  totalSize,
  trimTime,
}: {
  filesCount: number;
  reviewedCount: number;
  samplePath: string;
  totalSize: number;
  trimTime: number;
}) {
  return (
    <Card>
      <CardContent className="px-5 py-4">
        <div className="overflow-x-auto">
          <div className="flex min-w-max items-center gap-3 whitespace-nowrap text-sm text-slate-600">
            <span className="text-xs font-medium text-slate-400">概览</span>
            <span>
              视频 <span className="font-semibold text-slate-900">{filesCount.toLocaleString()}</span>
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
  );
}

export function BatchVideoSettingsCard({
  cancelling,
  editingTrim,
  filesCount,
  onCancel,
  onChooseOutputDirectory,
  onClearFiles,
  onInvalidTime,
  onOutputModeChange,
  onPreciseModeChange,
  onStart,
  onSuffixChange,
  onTrimInputChange,
  onTrimTimeChange,
  outputDir,
  outputMode,
  preciseMode,
  inputBusy,
  processing,
  progress,
  sampleInfo,
  setEditingTrim,
  setTrimInput,
  suffix,
  trimInput,
  trimTime,
}: {
  cancelling: boolean;
  editingTrim: boolean;
  filesCount: number;
  onCancel: () => void;
  onChooseOutputDirectory: () => void;
  onClearFiles: () => void;
  onInvalidTime: (message: string) => void;
  onOutputModeChange: (value: OutputMode) => void;
  onPreciseModeChange: (value: boolean) => void;
  onStart: () => void;
  onSuffixChange: (value: string) => void;
  onTrimInputChange: (value: string) => void;
  onTrimTimeChange: (value: number) => void;
  outputDir: string;
  outputMode: OutputMode;
  preciseMode: boolean;
  inputBusy: boolean;
  processing: boolean;
  progress: BatchTrimProgress | null;
  sampleInfo: VideoInfo | null;
  setEditingTrim: (value: boolean) => void;
  setTrimInput: (value: string) => void;
  suffix: string;
  trimInput: string;
  trimTime: number;
}) {
  return (
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
            onChange={(event) => onTrimInputChange(event.target.value)}
            onBlur={() => {
              setEditingTrim(false);
              const parsed = parseTimeInput(trimInput);
              if (parsed === null) {
                onInvalidTime("时间格式无效，请输入秒数或 mm:ss.ms / hh:mm:ss.ms");
                return;
              }
              onTrimTimeChange(sampleInfo ? clamp(parsed, 0, sampleInfo.duration) : Math.max(0, parsed));
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                (event.target as HTMLInputElement).blur();
              }
            }}
            className="font-mono"
            disabled={processing || inputBusy}
          />
          <div className="mt-2 text-[11px] text-slate-400">会统一删除每个视频开头的这段时间。</div>
        </div>

        <div className="rounded-[10px] border border-slate-200 bg-slate-50 px-4 py-3">
          <div className="text-sm font-medium text-slate-800">开始前确认</div>
          <div className="mt-2 text-[11px] text-slate-500">
            当前会对 <span className="font-medium text-slate-700">{filesCount.toLocaleString()}</span> 个视频统一删除前{" "}
            <span className="font-medium text-slate-700">{formatTime(trimTime)}</span>，输出到
            <span className="font-medium text-slate-700">
              {outputMode === "source" ? " 原目录" : outputDir ? ` ${outputDir}` : " 指定目录"}
            </span>
            ，文件名后缀为 <span className="font-medium text-slate-700">{suffix || "_trim"}</span>。
          </div>
        </div>

        <div className="rounded-[10px] border border-slate-200 bg-slate-50 px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-slate-800">精确模式</div>
              <div className="text-[11px] text-slate-500">更准，但更慢。</div>
            </div>
            <Switch checked={preciseMode} onCheckedChange={onPreciseModeChange} disabled={processing || inputBusy} />
          </div>
        </div>

        <div className="space-y-3 rounded-[10px] border border-slate-200 bg-slate-50 px-4 py-3">
          <div className="text-sm font-medium text-slate-800">输出位置</div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant={outputMode === "source" ? "primary" : "secondary"}
              size="sm"
              onClick={() => onOutputModeChange("source")}
              disabled={processing || inputBusy}
            >
              原目录
            </Button>
            <Button
              variant={outputMode === "directory" ? "primary" : "secondary"}
              size="sm"
              onClick={() => onOutputModeChange("directory")}
              disabled={processing || inputBusy}
            >
              指定目录
            </Button>
          </div>
          {outputMode === "directory" && (
            <div className="space-y-2">
              <div className="truncate text-xs text-slate-500">{outputDir || "尚未选择输出目录"}</div>
              <Button variant="ghost" size="sm" onClick={onChooseOutputDirectory} disabled={processing || inputBusy}>
                选择目录
              </Button>
            </div>
          )}
          <div>
            <div className="mb-2 text-xs text-slate-500">文件名后缀</div>
            <Input value={suffix} onChange={(event) => onSuffixChange(event.target.value)} disabled={processing || inputBusy} />
          </div>
        </div>

        {processing && progress && (
          <div className="space-y-2 rounded-[10px] border border-slate-200 bg-slate-50 px-4 py-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-800">{progress.stage}</span>
              <span className="font-mono text-[var(--brand-600)]">{progress.percent.toFixed(1)}%</span>
            </div>
            <Progress value={progress.percent} />
            <div className="text-[11px] text-slate-400">{getProgressText(progress)}</div>
          </div>
        )}

        <div className="space-y-3 border-t border-slate-100 pt-4">
          <Button variant="primary" className="w-full" onClick={onStart} disabled={processing || inputBusy || filesCount === 0}>
            {processing ? "处理中…" : inputBusy ? "正在读取素材…" : "开始批量去片头"}
          </Button>
          {processing && (
            <Button variant="danger" className="w-full" onClick={onCancel} disabled={cancelling}>
              {cancelling ? "正在取消..." : "取消处理"}
            </Button>
          )}
          <Button variant="ghost" className="w-full" onClick={onClearFiles} disabled={processing || inputBusy || filesCount === 0}>
            清空素材
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function BatchVideoFileListCard({
  files,
  onRemoveFile,
  onSelectSample,
  processing,
  samplePath,
}: {
  files: BatchVideoFile[];
  onRemoveFile: (path: string) => void;
  onSelectSample: (path: string) => void;
  processing: boolean;
  samplePath: string;
}) {
  return (
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
                "flex items-center gap-3 rounded-[10px] border px-3 py-3 transition",
                selected ? "border-[var(--brand-300)] bg-[var(--brand-50)]" : "border-slate-200 bg-white"
              )}
            >
              <button className="min-w-0 flex-1 text-left" onClick={() => onSelectSample(item.path)} disabled={processing}>
                <div className="truncate text-sm font-medium text-slate-900">{item.name}</div>
                <div className="truncate text-xs text-slate-500">{item.path}</div>
              </button>
              <div className="text-xs text-slate-400">{formatSize(item.size)}</div>
              {selected && <Badge tone="info">样本</Badge>}
              <Button variant="ghost" size="sm" onClick={() => onRemoveFile(item.path)} disabled={processing}>
                移除
              </Button>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

export function BatchVideoResultCard({
  firstSuccessOutput,
  onOpenFile,
  onRevealInDir,
  result,
}: {
  firstSuccessOutput: string;
  onOpenFile: (path: string) => void | Promise<void>;
  onRevealInDir: (path: string) => void | Promise<void>;
  result: BatchTrimResult | null;
}) {
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>处理结果</CardTitle>
        </div>
        {result && <Badge tone={result.cancelled ? "warning" : "default"}>{result.cancelled ? "已取消" : `${result.total} 项`}</Badge>}
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
                <Button variant="ghost" size="sm" onClick={() => void onRevealInDir(firstSuccessOutput)}>
                  打开首个输出位置
                </Button>
              )}
            </div>
            <div className="max-h-[360px] space-y-2 overflow-auto">
              {result.items.map((item) => (
                <div
                  key={`${item.input_path}-${item.status}`}
                  className={cn(
                    "rounded-[10px] border px-3 py-3 text-sm",
                    item.status === "success"
                      ? "border-emerald-100 bg-emerald-50/60"
                      : item.status === "skipped"
                        ? "border-amber-100 bg-amber-50/60"
                        : "border-rose-100 bg-rose-50/60"
                  )}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="truncate font-medium text-slate-900">{getBaseName(item.input_path)}</div>
                    <Badge tone={item.status === "success" ? "success" : item.status === "skipped" ? "warning" : "danger"}>
                      {item.status === "success" ? "成功" : item.status === "skipped" ? "跳过" : "失败"}
                    </Badge>
                  </div>
                  <div className="mt-1 truncate text-xs text-slate-500">{item.input_path}</div>
                  <div className="mt-2 text-xs text-slate-600">{item.message}</div>
                  {item.output_path && <div className="mt-1 truncate text-xs text-slate-400">{item.output_path}</div>}
                  <div className="mt-2 flex flex-wrap gap-2">
                    {item.output_path ? (
                      <>
                        <Button variant="ghost" size="sm" onClick={() => void onOpenFile(item.output_path!)}>
                          打开输出
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => void onRevealInDir(item.output_path!)}>
                          输出位置
                        </Button>
                      </>
                    ) : (
                      <Button variant="ghost" size="sm" onClick={() => void onRevealInDir(item.input_path)}>
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
  );
}
