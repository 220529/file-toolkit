import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useFileActions } from "../hooks/useFileActions";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { CardDescription, CardTitle } from "./ui/card";
import { Modal } from "./ui/modal";

interface Props {
  onClose: () => void;
}

export default function LogViewer({ onClose }: Props) {
  const [logs, setLogs] = useState("加载中…");
  const [logPath, setLogPath] = useState("");
  const [loading, setLoading] = useState(false);
  const fileActions = useFileActions();

  async function loadLogs() {
    setLoading(true);
    try {
      const [path, content] = await Promise.all([
        invoke<string>("get_log_path"),
        invoke<string>("get_recent_logs", { lines: 200 }),
      ]);
      setLogPath(path);
      setLogs(content || "暂无日志");
    } catch (e) {
      setLogs(`加载日志失败: ${e}`);
    } finally {
      setLoading(false);
    }
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
    <Modal onClose={onClose}>
      <div className="flex max-h-[84vh] flex-col">
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-6 py-5">
          <div className="min-w-0">
            <div className="mb-2 flex items-center gap-3">
              <Badge tone="info">运行日志</Badge>
              <Badge tone="default">最近 200 行</Badge>
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
            <Button variant="secondary" size="sm" onClick={() => void loadLogs()} disabled={loading}>
              {loading ? "刷新中…" : "刷新"}
            </Button>
          </div>
        </div>
        <div className="flex-1 overflow-auto bg-slate-950 px-6 py-5">
          <pre className="whitespace-pre-wrap break-words text-xs leading-6 text-slate-200">{logs}</pre>
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
