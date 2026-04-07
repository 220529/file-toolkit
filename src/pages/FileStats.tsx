import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { flushSync } from "react-dom";
import DropZone from "../components/DropZone";
import { useTaskReporter } from "../components/TaskCenter";
import { Badge } from "../components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Progress } from "../components/ui/progress";
import { useToast } from "../components/Toast";
import { safeListen } from "../utils/tauriEvent";
import { formatSize } from "../utils/format";

interface FileStats {
  extension: string;
  count: number;
  total_size: number;
}

interface ScanResult {
  stats: FileStats[];
  total_files: number;
  folder_count: number;
  total_size: number;
  type_count: number;
}

interface FileStatsProgress {
  task_id: string;
  stage: string;
  current: number;
  total: number;
  percent: number;
}

function SummaryCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "blue" | "emerald" | "orange";
}) {
  const toneClass = {
    blue: "from-blue-500/14 to-white",
    emerald: "from-emerald-500/14 to-white",
    orange: "from-orange-500/14 to-white",
  }[tone];

  return (
    <Card className={`bg-gradient-to-br ${toneClass}`}>
      <CardContent className="px-5 py-5">
        <div className="text-xs uppercase tracking-[0.2em] text-slate-400">{label}</div>
        <div className="mt-3 text-3xl font-semibold tracking-[-0.03em] text-slate-950">{value}</div>
      </CardContent>
    </Card>
  );
}

export default function FileStats({ active = true }: { active?: boolean }) {
  const [result, setResult] = useState<ScanResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedPath, setSelectedPath] = useState("");
  const [progress, setProgress] = useState<FileStatsProgress | null>(null);
  const toast = useToast();
  const task = useTaskReporter("file-stats");
  const currentTaskIdRef = useRef<string | null>(null);

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
    currentTaskIdRef.current = taskId;

    flushSync(() => {
      setSelectedPath(path);
      setLoading(true);
      setResult(null);
      setProgress({
        task_id: taskId,
        stage: "准备扫描文件夹",
        current: 0,
        total: 0,
        percent: 0,
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
    currentTaskIdRef.current = null;
    await invoke("cancel_file_stats");
    setLoading(false);
    setProgress(null);
    toast.info("已取消扫描");
  }

  useEffect(() => {
    if (!loading) {
      task.clearTask();
      return;
    }

    task.reportTask({
      title: "文件统计",
      stage: progress?.stage || "扫描文件夹",
      detail:
        progress && progress.current > 0
          ? `已扫描 ${progress.current.toLocaleString()} 个文件`
          : selectedPath || "等待扫描",
      progress: progress && progress.total > 0 ? progress.percent : undefined,
      cancellable: true,
      onCancel: cancelScan,
    });
  }, [loading, progress, selectedPath]);

  return (
    <div className="space-y-6 p-6">
      <DropZone onSelect={handleSelect} loading={loading} selectedPath={selectedPath} active={active} />

      {loading && progress && (
        <Card>
          <CardContent className="space-y-4 px-5 py-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-sm font-medium text-slate-900">{progress.stage}</div>
                <div className="mt-1 text-sm text-slate-500">
                  {progress.total > 0
                    ? `${progress.current.toLocaleString()} / ${progress.total.toLocaleString()}`
                    : `已扫描 ${progress.current.toLocaleString()} 个文件`}
                </div>
              </div>
              <Badge tone="info">扫描中</Badge>
            </div>
            <Progress value={progress.percent} indeterminate={progress.total === 0} />
          </CardContent>
        </Card>
      )}

      {result && (
        <>
          <div className="grid grid-cols-4 gap-3">
            <SummaryCard label="文件总数" value={result.total_files.toLocaleString()} tone="blue" />
            <SummaryCard label="文件夹数" value={result.folder_count.toLocaleString()} tone="emerald" />
            <SummaryCard label="文件类型" value={result.type_count.toLocaleString()} tone="emerald" />
            <SummaryCard label="占用总量" value={formatSize(result.total_size)} tone="orange" />
          </div>

          <Card>
            <CardHeader>
              <div>
                <CardTitle>文件类型分布</CardTitle>
              </div>
              <Badge tone="default">{result.stats.length} 项</Badge>
            </CardHeader>
            <CardContent className="overflow-hidden px-0 py-0">
              <div className="overflow-auto">
                <table className="table">
                  <thead>
                    <tr>
                      <th>类型</th>
                      <th className="text-right">数量</th>
                      <th className="text-right">占比</th>
                      <th className="text-right">总大小</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.stats.map((item) => (
                      <tr key={item.extension}>
                        <td>
                          <Badge tone="default">{item.extension}</Badge>
                        </td>
                        <td className="text-right font-medium text-slate-900">{item.count.toLocaleString()}</td>
                        <td className="text-right text-slate-500">
                          {((item.count / result.total_files) * 100).toFixed(1)}%
                        </td>
                        <td className="text-right text-slate-500">{formatSize(item.total_size)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
