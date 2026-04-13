import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { flushSync } from "react-dom";
import DropZone from "../components/DropZone";
import { useTaskReporter } from "../components/TaskCenter";
import { EmptyState } from "../components/ui/empty-state";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Progress } from "../components/ui/progress";
import { useToast } from "../components/Toast";
import { useFileActions } from "../hooks/useFileActions";
import { safeListen } from "../utils/tauriEvent";
import { formatSize } from "../utils/format";

interface FileStats {
  extension: string;
  count: number;
  total_size: number;
}

interface ScanIssue {
  path: string;
  reason: string;
}

interface ScanResult {
  stats: FileStats[];
  total_files: number;
  folder_count: number;
  total_size: number;
  type_count: number;
  skipped_files: number;
  permission_denied_files: number;
  sample_errors: ScanIssue[];
}

interface FileStatsProgress {
  task_id: string;
  stage: string;
  current: number;
  total: number;
  percent: number;
  elapsed_ms: number;
  files_per_second: number;
  skipped_files: number;
  permission_denied_files: number;
}

type SortMode = "size" | "count";
const DEFAULT_VISIBLE_ROWS = 20;

function formatElapsed(ms: number) {
  if (ms <= 0) return "0.0 秒";
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} 秒`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes} 分 ${seconds.toString().padStart(2, "0")} 秒`;
}

function formatScanRate(rate: number) {
  if (!Number.isFinite(rate) || rate <= 0) return "计算中";
  if (rate >= 1000) return `${(rate / 1000).toFixed(1)}k 文件/s`;
  if (rate >= 100) return `${rate.toFixed(0)} 文件/s`;
  return `${rate.toFixed(1)} 文件/s`;
}

function getProgressDetail(progress: FileStatsProgress | null, selectedPath: string) {
  if (!progress) return selectedPath || "等待扫描";

  const segments = [`已统计 ${progress.current.toLocaleString()} 个文件`];
  if (progress.skipped_files > 0) {
    segments.push(`跳过 ${progress.skipped_files.toLocaleString()} 项`);
  }
  if (progress.files_per_second > 0) {
    segments.push(formatScanRate(progress.files_per_second));
  }
  if (progress.elapsed_ms > 0) {
    segments.push(`耗时 ${formatElapsed(progress.elapsed_ms)}`);
  }
  return segments.join(" · ");
}

export default function FileStats({ active = true }: { active?: boolean }) {
  const [result, setResult] = useState<ScanResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedPath, setSelectedPath] = useState("");
  const [progress, setProgress] = useState<FileStatsProgress | null>(null);
  const [sortBy, setSortBy] = useState<SortMode>("size");
  const [filterText, setFilterText] = useState("");
  const [showAllRows, setShowAllRows] = useState(false);
  const toast = useToast();
  const task = useTaskReporter("file-stats");
  const currentTaskIdRef = useRef<string | null>(null);
  const { openFile } = useFileActions();

  useEffect(() => {
    if (!active) return;

    return safeListen<FileStatsProgress>("file-stats-progress", (event) => {
      if (event.payload.task_id !== currentTaskIdRef.current) return;
      setProgress((prev) => {
        if (
          prev &&
          prev.task_id === event.payload.task_id &&
          prev.stage === event.payload.stage &&
          event.payload.current < prev.current
        ) {
          return prev;
        }
        return event.payload;
      });
    });
  }, [active]);

  async function handleSelect(path: string) {
    if (loading) return;
    const taskId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const isSamePath = path === selectedPath;
    currentTaskIdRef.current = taskId;

    flushSync(() => {
      setSelectedPath(path);
      setLoading(true);
      if (!isSamePath) {
        setResult(null);
        setFilterText("");
        setShowAllRows(false);
      }
      setProgress({
        task_id: taskId,
        stage: "准备扫描文件夹",
        current: 0,
        total: 0,
        percent: 0,
        elapsed_ms: 0,
        files_per_second: 0,
        skipped_files: 0,
        permission_denied_files: 0,
      });
    });

    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });

    try {
      const res = await invoke<ScanResult>("scan_directory", { path, taskId });
      if (currentTaskIdRef.current !== taskId) return;
      setResult(res);
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

  async function cancelScan() {
    const taskId = currentTaskIdRef.current;
    if (!taskId) return;

    try {
      await invoke("cancel_file_stats", { taskId });
      currentTaskIdRef.current = null;
      setLoading(false);
      setProgress(null);
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
      title: "文件统计",
      stage: progress?.stage || "扫描文件夹",
      detail: getProgressDetail(progress, selectedPath),
      progress: progress && progress.total > 0 ? progress.percent : undefined,
      cancellable: true,
      onCancel: cancelScan,
    });
  }, [loading, progress, selectedPath]);

  const sortedStats = result
    ? [...result.stats].sort((a, b) => {
        if (sortBy === "count") {
          return b.count - a.count || b.total_size - a.total_size || a.extension.localeCompare(b.extension);
        }
        return b.total_size - a.total_size || b.count - a.count || a.extension.localeCompare(b.extension);
      })
    : [];
  const normalizedFilter = filterText.trim().toLowerCase();
  const filteredStats = normalizedFilter
    ? sortedStats.filter((item) => item.extension.toLowerCase().includes(normalizedFilter))
    : sortedStats;
  const visibleStats = showAllRows || normalizedFilter ? filteredStats : filteredStats.slice(0, DEFAULT_VISIBLE_ROWS);
  const hiddenRowCount = filteredStats.length - visibleStats.length;
  const isRefreshingCurrentResult = loading && !!result;
  const topBySize = result?.stats[0] ?? null;
  const topByCount = result
    ? result.stats.reduce<FileStats | null>((current, item) => {
        if (!current) return item;
        if (item.count > current.count) return item;
        if (item.count === current.count && item.total_size > current.total_size) return item;
        return current;
      }, null)
    : null;

  return (
    <div className="space-y-6 p-6">
      <DropZone
        onSelect={handleSelect}
        loading={loading}
        selectedPath={selectedPath}
        active={active}
        footerActions={
          selectedPath ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => void openFile(selectedPath)}>
                打开目录
              </Button>
              <Button size="sm" variant="secondary" onClick={() => void handleSelect(selectedPath)} disabled={loading}>
                重新扫描
              </Button>
            </>
          ) : undefined
        }
      />

      {loading && progress && (
          <Card>
          <CardContent className="space-y-4 px-5 py-5">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <div className="text-sm font-medium text-slate-900">{progress.stage}</div>
                <div className="mt-1 truncate text-sm text-slate-500" title={getProgressDetail(progress, selectedPath)}>
                  {getProgressDetail(progress, selectedPath)}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {progress.skipped_files > 0 && (
                  <Badge tone="warning">已跳过 {progress.skipped_files.toLocaleString()}</Badge>
                )}
                {progress.permission_denied_files > 0 && (
                  <Badge tone="warning">权限不足 {progress.permission_denied_files.toLocaleString()}</Badge>
                )}
                <Badge tone="default">逻辑大小</Badge>
                <Badge tone="info">扫描中</Badge>
                <Button size="sm" variant="ghost" onClick={() => void cancelScan()}>
                  取消
                </Button>
              </div>
            </div>
            <Progress value={progress.percent} indeterminate={progress.total === 0} />
          </CardContent>
        </Card>
      )}

      {result && (
        <>
          <Card className="bg-[linear-gradient(135deg,rgba(255,255,255,0.96),rgba(245,248,255,0.92))]">
            <CardContent className="px-5 py-4">
              <div className="overflow-x-auto">
                <div className="flex min-w-max items-center gap-3 whitespace-nowrap text-sm text-slate-600">
                  <span className="text-xs font-medium uppercase tracking-[0.18em] text-slate-400">概览</span>
                  <span>
                    文件 <span className="font-semibold text-slate-900">{result.total_files.toLocaleString()}</span>
                  </span>
                  <span className="text-slate-300">/</span>
                  <span>
                    目录 <span className="font-semibold text-slate-900">{result.folder_count.toLocaleString()}</span>
                  </span>
                  <span className="text-slate-300">/</span>
                  <span>
                    总大小 <span className="font-semibold text-slate-900">{formatSize(result.total_size)}</span>
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

          {topBySize && topByCount && (
            <Card className="bg-[linear-gradient(135deg,rgba(255,255,255,0.96),rgba(245,248,255,0.92))]">
              <CardContent className="flex flex-col gap-2 px-5 py-4 md:flex-row md:items-center md:justify-between">
                <div
                  className="min-w-0 truncate text-sm text-slate-600"
                  title={`空间主要被 ${topBySize.extension} 占用，约 ${
                    result.total_size > 0 ? ((topBySize.total_size / result.total_size) * 100).toFixed(1) : "0.0"
                  }%，共 ${formatSize(topBySize.total_size)}`}
                >
                  空间主要被 <span className="font-semibold text-slate-900">{topBySize.extension}</span> 占用，约{" "}
                  {result.total_size > 0 ? ((topBySize.total_size / result.total_size) * 100).toFixed(1) : "0.0"}%，共{" "}
                  {formatSize(topBySize.total_size)}
                </div>
                <div
                  className="min-w-0 truncate text-sm text-slate-600"
                  title={`数量最多的是 ${topByCount.extension}，共 ${topByCount.count.toLocaleString()} 个`}
                >
                  数量最多的是 <span className="font-semibold text-slate-900">{topByCount.extension}</span>，共{" "}
                  {topByCount.count.toLocaleString()} 个
                </div>
              </CardContent>
            </Card>
          )}

          {result.skipped_files > 0 && (
            <Card className="border-amber-100 bg-gradient-to-br from-amber-50/80 to-white">
              <CardContent className="space-y-4 px-5 py-5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-amber-900">部分项目未纳入统计结果</div>
                    <div
                      className="mt-1 truncate text-sm text-amber-800/80"
                      title={`已跳过 ${result.skipped_files.toLocaleString()} 项，其中权限不足 ${result.permission_denied_files.toLocaleString()} 项。常见原因是权限受限、文件在扫描时被移动，或元数据读取失败。`}
                    >
                      已跳过 {result.skipped_files.toLocaleString()} 项，其中权限不足{" "}
                      {result.permission_denied_files.toLocaleString()} 项。常见原因是权限受限、文件在扫描时被移动，或元数据读取失败。
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

          {result.stats.length === 0 ? (
            <EmptyState
              icon="🗂"
              title="没有可展示的文件类型"
              description={
                result.skipped_files > 0
                  ? "这个目录里的项目大多无法读取，或者扫描过程中已经被移动。上方告警卡片里保留了部分样本。"
                  : "目录里还没有文件，或者只有当前版本不会纳入统计的特殊项目。"
              }
            />
          ) : (
            <Card>
              <CardHeader className="flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <CardTitle>文件类型分布</CardTitle>
                  <CardDescription className="truncate" title={isRefreshingCurrentResult ? "按文件逻辑大小统计，可在空间占用和文件数量之间切换排序。当前展示的是上一版结果，扫描完成后会自动刷新。" : "按文件逻辑大小统计，可在空间占用和文件数量之间切换排序。"}>
                    按文件逻辑大小统计，可在空间占用和文件数量之间切换排序。
                    {isRefreshingCurrentResult ? " 当前展示的是上一版结果，扫描完成后会自动刷新。" : ""}
                  </CardDescription>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" variant={sortBy === "size" ? "primary" : "secondary"} onClick={() => setSortBy("size")}>
                    按大小
                  </Button>
                  <Button
                    size="sm"
                    variant={sortBy === "count" ? "primary" : "secondary"}
                    onClick={() => setSortBy("count")}
                  >
                    按数量
                  </Button>
                  {isRefreshingCurrentResult && <Badge tone="info">结果刷新中</Badge>}
                  <Badge tone="default">{filteredStats.length} 项</Badge>
                </div>
              </CardHeader>
              <CardContent className="overflow-hidden px-0 py-0">
                <div className="flex flex-col gap-3 border-b border-slate-100 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0 flex-1">
                    <Input
                      value={filterText}
                      onChange={(event) => {
                        setFilterText(event.target.value);
                        setShowAllRows(false);
                      }}
                      placeholder="筛选扩展名，例如 .jpg、.mp4、无扩展名"
                      className="max-w-md"
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    {!normalizedFilter && filteredStats.length > DEFAULT_VISIBLE_ROWS && (
                      <>
                        <span className="whitespace-nowrap">默认显示前 {DEFAULT_VISIBLE_ROWS.toLocaleString()} 项</span>
                        <Button size="sm" variant="ghost" onClick={() => setShowAllRows((value) => !value)}>
                          {showAllRows ? "收起" : "显示全部"}
                        </Button>
                      </>
                    )}
                    {normalizedFilter && <span className="whitespace-nowrap">筛选后显示 {filteredStats.length.toLocaleString()} 项</span>}
                  </div>
                </div>
                <div className="overflow-auto">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>类型</th>
                        <th className="text-right">数量</th>
                        <th className="text-right">数量占比</th>
                        <th className="text-right">逻辑大小</th>
                        <th className="text-right">大小占比</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleStats.map((item, index) => (
                        <tr key={item.extension}>
                          <td>
                            <div className="flex items-center gap-3">
                              <span className="w-7 text-right text-xs tabular-nums text-slate-400">
                                {(index + 1).toString().padStart(2, "0")}
                              </span>
                              <Badge tone="default">{item.extension}</Badge>
                            </div>
                          </td>
                          <td className="text-right font-medium text-slate-900">{item.count.toLocaleString()}</td>
                          <td className="text-right text-slate-500">
                            {result.total_files > 0 ? ((item.count / result.total_files) * 100).toFixed(1) : "0.0"}%
                          </td>
                          <td className="text-right text-slate-500">{formatSize(item.total_size)}</td>
                          <td className="text-right text-slate-500">
                            <div className="ml-auto flex max-w-[150px] flex-col gap-2">
                              <div>{result.total_size > 0 ? ((item.total_size / result.total_size) * 100).toFixed(1) : "0.0"}%</div>
                              <Progress
                                value={result.total_size > 0 ? (item.total_size / result.total_size) * 100 : 0}
                                className="h-1.5 bg-slate-200/90"
                                barClassName="bg-[linear-gradient(90deg,#2563eb,#3b82f6)]"
                              />
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {filteredStats.length === 0 && (
                  <div className="px-5 py-10 text-center text-sm text-slate-500">没有匹配的文件类型，试试更短一点的关键词。</div>
                )}
                {hiddenRowCount > 0 && (
                  <div className="border-t border-slate-100 px-5 py-4">
                    <Button size="sm" variant="secondary" onClick={() => setShowAllRows(true)}>
                      再显示 {hiddenRowCount.toLocaleString()} 项
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
