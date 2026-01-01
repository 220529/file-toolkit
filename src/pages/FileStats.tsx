import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import DropZone from "../components/DropZone";
import { formatSize } from "../utils/format";

interface FileStats {
  extension: string;
  count: number;
  total_size: number;
}

interface ScanResult {
  stats: FileStats[];
  total_files: number;
  total_size: number;
  type_count: number;
}

export default function FileStats({ active = true }: { active?: boolean }) {
  const [result, setResult] = useState<ScanResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedPath, setSelectedPath] = useState("");

  async function handleSelect(path: string) {
    setSelectedPath(path);
    setLoading(true);
    try {
      const res = await invoke<ScanResult>("scan_directory", { path });
      setResult(res);
    } catch (e) {
      console.error(e);
      alert("扫描失败: " + e);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="p-6 space-y-6">
      {/* 拖拽选择区域 */}
      <DropZone onSelect={handleSelect} loading={loading} selectedPath={selectedPath} active={active} />

      {/* 统计结果 */}
      {result && (
        <>
          {/* 统计卡片 */}
          <div className="grid grid-cols-3 gap-4">
            <div className="stat-card">
              <div className="text-sm opacity-80 mb-1">文件总数</div>
              <div className="text-2xl font-bold">{result.total_files.toLocaleString()}</div>
            </div>
            <div className="stat-card green">
              <div className="text-sm opacity-80 mb-1">文件类型</div>
              <div className="text-2xl font-bold">{result.type_count}</div>
            </div>
            <div className="stat-card orange">
              <div className="text-sm opacity-80 mb-1">总大小</div>
              <div className="text-2xl font-bold">{formatSize(result.total_size)}</div>
            </div>
          </div>

          {/* 详细表格 */}
          <div className="card">
            <div className="px-4 py-3 border-b border-gray-100">
              <span className="font-medium">文件类型分布</span>
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th>文件类型</th>
                  <th className="text-right">数量</th>
                  <th className="text-right">占比</th>
                  <th className="text-right">总大小</th>
                </tr>
              </thead>
              <tbody>
                {result.stats.map((s) => (
                  <tr key={s.extension}>
                    <td>
                      <span className="tag tag-default">{s.extension}</span>
                    </td>
                    <td className="text-right font-medium" style={{ color: "var(--primary-color)" }}>
                      {s.count.toLocaleString()}
                    </td>
                    <td className="text-right text-gray-500">
                      {((s.count / result.total_files) * 100).toFixed(1)}%
                    </td>
                    <td className="text-right text-gray-500">{formatSize(s.total_size)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
