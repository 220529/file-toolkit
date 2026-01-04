import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface Props {
  onClose: () => void;
}

export default function LogViewer({ onClose }: Props) {
  const [logs, setLogs] = useState<string>("");
  const [logPath, setLogPath] = useState<string>("");
  const [loading, setLoading] = useState(false);

  const loadLogs = async () => {
    setLoading(true);
    try {
      const [path, content] = await Promise.all([
        invoke<string>("get_log_path"),
        invoke<string>("get_recent_logs", { lines: 200 }),
      ]);
      setLogPath(path);
      setLogs(content);
    } catch (e) {
      setLogs(`加载日志失败: ${e}`);
    }
    setLoading(false);
  };

  // 首次加载
  useState(() => {
    loadLogs();
  });

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-2xl w-[700px] max-h-[80vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="p-4 border-b border-gray-100 flex items-center justify-between">
          <div>
            <h3 className="font-medium">📋 运行日志</h3>
            {logPath && (
              <p className="text-xs text-gray-400 mt-1 font-mono">{logPath}</p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={loadLogs}
              disabled={loading}
              className="px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
            >
              {loading ? "⏳" : "🔄"} 刷新
            </button>
          </div>
        </div>

        {/* 日志内容 */}
        <div className="flex-1 overflow-auto p-4 bg-gray-900">
          <pre className="text-xs text-gray-300 font-mono whitespace-pre-wrap leading-relaxed">
            {logs || "暂无日志"}
          </pre>
        </div>

        {/* 底部 */}
        <div className="p-3 bg-gray-50 border-t border-gray-100 flex justify-between items-center">
          <span className="text-xs text-gray-400">
            日志自动保留 7 天
          </span>
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm bg-blue-500 hover:bg-blue-600 text-white rounded-lg transition-colors"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
