import { useEffect, useMemo, useState } from "react";
import { getLogPath, getRecentLogs } from "../api/tauri";
import { useFileActions } from "../hooks/useFileActions";
import { cn } from "../utils/cn";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { CardDescription, CardTitle } from "./ui/card";
import { Icon } from "./ui/icon";
import { Input } from "./ui/input";
import { Modal } from "./ui/modal";

interface Props {
  onClose: () => void;
}

export default function LogViewer({ onClose }: Props) {
  const [logs, setLogs] = useState("加载中…");
  const [logPath, setLogPath] = useState("");
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState<LogLevelFilter>("all");
  const [module, setModule] = useState<LogModuleFilter>("all");
  const fileActions = useFileActions();

  const logLines = useMemo(() => logs.split(/\r?\n/).filter(Boolean), [logs]);
  const filteredLines = useMemo(
    () => filterLogLines(logLines, { query, level, module }),
    [level, logLines, module, query]
  );
  const errorCount = useMemo(() => countLevel(logLines, "ERROR"), [logLines]);
  const warningCount = useMemo(() => countLevel(logLines, "WARN"), [logLines]);
  const visibleLogs = filteredLines.length > 0 ? filteredLines.join("\n") : "没有匹配的日志";

  async function loadLogs() {
    setLoading(true);
    try {
      const [path, content] = await Promise.all([getLogPath(), getRecentLogs(200)]);
      setLogPath(path);
      setLogs(content || "暂无日志");
    } catch (e) {
      setLogs(`加载日志失败: ${e}`);
    } finally {
      setLoading(false);
    }
  }

  async function copyVisibleLogs() {
    await navigator.clipboard.writeText(visibleLogs);
  }

  useEffect(() => {
    void loadLogs();
    const timer = window.setInterval(() => {
      void loadLogs();
    }, 2000);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  return (
    <Modal onClose={onClose} accessibleTitle="日志查看器">
      <div className="flex max-h-[84vh] flex-col">
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-6 py-5">
          <div className="min-w-0">
            <div className="mb-2 flex items-center gap-3">
              <Badge tone="info">运行日志</Badge>
              <Badge tone="default">最近 200 行</Badge>
              {errorCount > 0 && <Badge tone="danger">{errorCount} 错误</Badge>}
              {warningCount > 0 && <Badge tone="warning">{warningCount} 警告</Badge>}
            </div>
            <CardTitle className="text-xl">日志查看器</CardTitle>
            <CardDescription className="mt-2">
              用于排查扫描、哈希、ffmpeg 处理等运行状态。
            </CardDescription>
            {logPath && <div className="mt-2 truncate text-xs text-slate-400">{logPath}</div>}
          </div>
          <div className="flex items-center gap-2">
            {logPath && (
              <Button variant="secondary" size="sm" onClick={() => void fileActions.openFile(logPath)}>
                打开位置
              </Button>
            )}
            <Button variant="secondary" size="sm" onClick={() => void copyVisibleLogs()}>
              <Icon name="duplicate" size={14} />
              复制
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void loadLogs()} disabled={loading}>
              {loading ? "刷新中…" : "刷新"}
            </Button>
          </div>
        </div>
        <div className="space-y-3 border-b border-slate-100 bg-white px-6 py-4">
          <div className="grid gap-3 lg:grid-cols-[minmax(220px,1fr)_auto_auto]">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索错误、路径、任务 ID 或模块"
            />
            <div className="flex rounded-[8px] border border-slate-200 bg-slate-50 p-1">
              {levelFilters.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  onClick={() => setLevel(item.value)}
                  className={cn(
                    "h-8 rounded-[6px] px-3 text-xs font-medium transition",
                    level === item.value ? "bg-white text-slate-950 shadow-sm" : "text-slate-500 hover:text-slate-900"
                  )}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <div className="flex rounded-[8px] border border-slate-200 bg-slate-50 p-1">
              {moduleFilters.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  onClick={() => setModule(item.value)}
                  className={cn(
                    "h-8 rounded-[6px] px-3 text-xs font-medium transition",
                    module === item.value ? "bg-white text-slate-950 shadow-sm" : "text-slate-500 hover:text-slate-900"
                  )}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
          <div className="text-xs text-slate-500">
            显示 {filteredLines.length} / {logLines.length} 行
          </div>
        </div>
        <div className="flex-1 overflow-auto bg-slate-950 px-6 py-5">
          <pre className="whitespace-pre-wrap break-words text-xs leading-6 text-slate-200">{visibleLogs}</pre>
        </div>
        <div className="flex items-center justify-between border-t border-slate-100 bg-slate-50 px-6 py-4">
          <div className="text-xs text-slate-500">日志文件默认保留 7 天。</div>
          <Button variant="primary" onClick={onClose}>
            关闭
          </Button>
        </div>
      </div>
    </Modal>
  );
}

type LogLevelFilter = "all" | "error" | "warn" | "info";
type LogModuleFilter = "all" | "text-image" | "watermark" | "dedup" | "video";

const levelFilters: Array<{ value: LogLevelFilter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "error", label: "错误" },
  { value: "warn", label: "警告" },
  { value: "info", label: "信息" },
];

const moduleFilters: Array<{ value: LogModuleFilter; label: string; token?: string }> = [
  { value: "all", label: "全部模块" },
  { value: "text-image", label: "文生图", token: "[文生图]" },
  { value: "watermark", label: "去水印", token: "[去水印]" },
  { value: "dedup", label: "去重", token: "[去重]" },
  { value: "video", label: "视频", token: "[视频]" },
];

function filterLogLines(
  lines: string[],
  filters: { query: string; level: LogLevelFilter; module: LogModuleFilter }
) {
  const keyword = filters.query.trim().toLowerCase();
  const moduleToken = moduleFilters.find((item) => item.value === filters.module)?.token;

  return lines.filter((line) => {
    if (filters.level !== "all" && !line.includes(`[${filters.level.toUpperCase()}]`)) {
      return false;
    }
    if (moduleToken && !line.includes(moduleToken)) {
      return false;
    }
    if (keyword && !line.toLowerCase().includes(keyword)) {
      return false;
    }
    return true;
  });
}

function countLevel(lines: string[], level: "ERROR" | "WARN") {
  return lines.filter((line) => line.includes(`[${level}]`)).length;
}
