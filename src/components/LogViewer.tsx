import { useEffect, useMemo, useState } from "react";
import { getLogPath, getRecentLogs } from "../api/tauri";
import { useFileActions } from "../hooks/useFileActions";
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
  const fileActions = useFileActions();

  const logLines = useMemo(() => logs.split(/\r?\n/).filter(Boolean), [logs]);
  const filteredLines = useMemo(
    () => filterLogLines(logLines, query),
    [logLines, query]
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
    <Modal onClose={onClose} accessibleTitle="日志查看器" className="max-w-[1040px]">
      <div className="flex h-[min(820px,88vh)] flex-col overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-[var(--stroke)] px-5 py-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 flex-1">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <Badge tone="info">运行日志</Badge>
              <Badge tone="default">最近 200 行</Badge>
              {errorCount > 0 && <Badge tone="danger">{errorCount} 错误</Badge>}
              {warningCount > 0 && <Badge tone="warning">{warningCount} 警告</Badge>}
            </div>
            <CardTitle className="text-xl">日志查看器</CardTitle>
            <CardDescription className="mt-1">
              用于排查扫描、哈希、ffmpeg 处理等运行状态。
            </CardDescription>
            {logPath && <div className="mt-2 truncate text-xs text-[var(--text-soft)]" title={logPath}>{logPath}</div>}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
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
        <div className="border-b border-[var(--stroke)] bg-white px-5 py-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索模块、状态或任务 ID"
            />
            </div>
            <div className="shrink-0 text-xs text-[var(--text-muted)]">
              显示 {filteredLines.length} / {logLines.length} 行
            </div>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto bg-slate-950 px-5 py-4">
          <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-6 text-slate-200">{visibleLogs}</pre>
        </div>
        <div className="flex items-center justify-between border-t border-[var(--stroke)] bg-[#f7f8f5] px-5 py-3">
          <div className="text-xs text-[var(--text-muted)]">日志默认保留 7 天，单日最多 5 MB，不记录文件路径。</div>
          <Button variant="primary" onClick={onClose}>
            关闭
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function filterLogLines(lines: string[], query: string) {
  const keyword = query.trim().toLowerCase();

  return lines.filter((line) => {
    if (keyword && !line.toLowerCase().includes(keyword)) {
      return false;
    }
    return true;
  });
}

function countLevel(lines: string[], level: "ERROR" | "WARN") {
  return lines.filter((line) => line.includes(`[${level}]`)).length;
}
