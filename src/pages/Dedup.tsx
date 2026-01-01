import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirm } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import DropZone from "../components/DropZone";
import { formatSize } from "../utils/format";

interface FileInfo {
  path: string;
  name: string;
  size: number;
  modified: number;
}

interface DuplicateGroup {
  hash: string;
  size: number;
  files: FileInfo[];
}

interface DedupResult {
  groups: DuplicateGroup[];
  total_groups: number;
  total_duplicates: number;
  wasted_size: number;
}

interface DedupProgress {
  stage: string;
  current: number;
  total: number;
  percent: number;
}

export default function Dedup({ active = true }: { active?: boolean }) {
  const [result, setResult] = useState<DedupResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [selectedPath, setSelectedPath] = useState("");
  const [progress, setProgress] = useState<DedupProgress | null>(null);
  const [thumbnails, setThumbnails] = useState<Map<string, string>>(new Map());
  const [groupThumbnails, setGroupThumbnails] = useState<Map<string, string>>(new Map());
  const [previewImage, setPreviewImage] = useState<string | null>(null);

  // 监听进度事件
  useEffect(() => {
    const unlisten = listen<DedupProgress>("dedup-progress", (event) => {
      setProgress(event.payload);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // 加载缩略图
  async function loadThumbnail(path: string) {
    if (thumbnails.has(path)) return;
    try {
      const thumb = await invoke<string>("get_file_thumbnail", { path });
      setThumbnails((prev) => new Map(prev).set(path, thumb));
    } catch {
      // 不支持的文件类型，忽略
      setThumbnails((prev) => new Map(prev).set(path, ""));
    }
  }

  // 加载组预览缩略图
  async function loadGroupThumbnail(hash: string, path: string) {
    if (groupThumbnails.has(hash)) return;
    try {
      const thumb = await invoke<string>("get_file_thumbnail", { path });
      setGroupThumbnails((prev) => new Map(prev).set(hash, thumb));
    } catch {
      setGroupThumbnails((prev) => new Map(prev).set(hash, ""));
    }
  }

  // 扫描完成后自动加载组预览
  useEffect(() => {
    if (result && result.groups.length > 0) {
      result.groups.forEach((group) => {
        if (isPreviewable(group.files[0].name)) {
          loadGroupThumbnail(group.hash, group.files[0].path);
        }
      });
    }
  }, [result]);

  // 判断是否为可预览的文件类型
  function isPreviewable(name: string): boolean {
    const ext = name.split(".").pop()?.toLowerCase() || "";
    return ["jpg", "jpeg", "png", "gif", "bmp", "webp", "mp4", "mov", "avi", "mkv", "wmv", "flv", "webm"].includes(ext);
  }

  // 获取文件类型图标
  function getFileIcon(name: string): string {
    const ext = name.split(".").pop()?.toLowerCase() || "";
    if (["jpg", "jpeg", "png", "gif", "bmp", "webp"].includes(ext)) return "🖼️";
    if (["mp4", "mov", "avi", "mkv", "wmv", "flv", "webm"].includes(ext)) return "🎬";
    if (["mp3", "wav", "flac", "aac", "ogg"].includes(ext)) return "🎵";
    if (["pdf"].includes(ext)) return "📄";
    if (["doc", "docx"].includes(ext)) return "📝";
    if (["xls", "xlsx"].includes(ext)) return "📊";
    if (["zip", "rar", "7z", "tar", "gz"].includes(ext)) return "📦";
    return "📁";
  }

  async function handleSelect(path: string) {
    setSelectedPath(path);
    setLoading(true);
    setSelected(new Set());
    setProgress(null);
    try {
      const res = await invoke<DedupResult>("find_duplicates", { path });
      setResult(res);
    } catch (e) {
      console.error(e);
      alert("扫描失败: " + e);
    } finally {
      setLoading(false);
      setProgress(null);
    }
  }

  function toggleSelect(path: string) {
    const newSelected = new Set(selected);
    if (newSelected.has(path)) {
      newSelected.delete(path);
    } else {
      newSelected.add(path);
    }
    setSelected(newSelected);
  }

  function autoSelect() {
    if (!result) return;
    const toDelete = new Set<string>();
    result.groups.forEach((group) => {
      const sorted = [...group.files].sort((a, b) => a.modified - b.modified);
      sorted.slice(1).forEach((f) => toDelete.add(f.path));
    });
    setSelected(toDelete);
  }

  async function deleteSelected() {
    if (selected.size === 0) return;

    const confirmed = await confirm(
      `确定要删除选中的 ${selected.size} 个文件吗？\n此操作不可恢复！`,
      { title: "确认删除", kind: "warning" }
    );

    if (confirmed) {
      try {
        const deleted = await invoke<number>("delete_files", {
          paths: Array.from(selected),
        });
        alert(`成功删除 ${deleted} 个文件`);
        if (selectedPath) {
          const res = await invoke<DedupResult>("find_duplicates", { path: selectedPath });
          setResult(res);
          setSelected(new Set());
        }
      } catch (e) {
        alert("删除失败: " + e);
      }
    }
  }

  async function cancelScan() {
    await invoke("cancel_dedup");
    setLoading(false);
    setProgress(null);
  }

  return (
    <div className="p-6 space-y-6">
      {/* 拖拽选择区域 */}
      <DropZone onSelect={handleSelect} loading={loading} selectedPath={selectedPath} active={active} />

      {/* 进度条 */}
      {loading && progress && (
        <div className="card p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-gray-600">{progress.stage}</span>
            <div className="flex items-center gap-4">
              <span className="text-sm text-gray-500">
                {progress.total > 0
                  ? `${progress.current.toLocaleString()} / ${progress.total.toLocaleString()}`
                  : `已扫描 ${progress.current.toLocaleString()} 个文件`}
              </span>
              <button
                onClick={cancelScan}
                className="text-sm text-red-500 hover:text-red-700"
              >
                ✕ 取消
              </button>
            </div>
          </div>
          <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-500 transition-all duration-300"
              style={{ width: `${progress.percent}%` }}
            />
          </div>
        </div>
      )}

      {/* 工具栏 */}
      {result && result.groups.length > 0 && (
        <div className="card p-4">
          <div className="flex items-center justify-between">
            <div className="text-gray-600">
              发现 <span className="font-bold text-orange-500">{result.total_groups}</span> 组重复文件，
              共 <span className="font-bold text-orange-500">{result.total_duplicates}</span> 个重复，
              可释放 <span className="font-bold text-red-500">{formatSize(result.wasted_size)}</span>
            </div>
            <div className="flex gap-3">
              <button onClick={autoSelect} className="btn btn-default">
                🔄 智能选择
              </button>
              <button
                onClick={deleteSelected}
                disabled={selected.size === 0}
                className="btn btn-danger"
              >
                🗑️ 删除选中 ({selected.size})
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 无重复提示 */}
      {result && result.groups.length === 0 && (
        <div className="card p-8 text-center">
          <div className="text-5xl mb-4">✅</div>
          <div className="text-lg text-gray-600">太棒了！没有发现重复文件</div>
        </div>
      )}

      {/* 重复文件列表 */}
      {result && result.groups.length > 0 && (
        <div className="space-y-4">
          {result.groups.map((group, idx) => {
            // 按修改时间排序，最早的排第一
            const sortedFiles = [...group.files].sort((a, b) => a.modified - b.modified);
            const groupThumb = groupThumbnails.get(group.hash);
            const canPreview = isPreviewable(group.files[0].name);
            
            return (
            <div key={group.hash} className="card overflow-hidden">
              <div className="px-4 py-3 bg-gray-50 border-b border-gray-100 flex items-center gap-3">
                {/* 组预览缩略图 */}
                {canPreview && (
                  <div 
                    className="w-14 h-14 flex-shrink-0 rounded-lg overflow-hidden bg-gray-200 cursor-pointer hover:ring-2 hover:ring-blue-400 transition-all"
                    onClick={() => groupThumb && setPreviewImage(groupThumb)}
                  >
                    {groupThumb ? (
                      <img src={groupThumb} alt="" className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-gray-400 text-xs">
                        加载中
                      </div>
                    )}
                  </div>
                )}
                {!canPreview && (
                  <div className="w-14 h-14 flex-shrink-0 rounded-lg bg-gray-200 flex items-center justify-center text-2xl">
                    {getFileIcon(group.files[0].name)}
                  </div>
                )}
                
                <div className="flex-1 min-w-0">
                  <div className="font-medium">
                    第 {idx + 1} 组
                    <span className="ml-2 text-gray-400 font-normal text-sm">
                      {formatSize(group.size)} × {group.files.length} 个文件
                    </span>
                  </div>
                  <div className="text-sm text-gray-400 truncate">
                    {group.files[0].name}
                  </div>
                </div>
                
                <span className="text-sm text-orange-500 font-medium">
                  可释放 {formatSize(group.size * (group.files.length - 1))}
                </span>
              </div>
              <div>
                {sortedFiles.map((file, fileIdx) => (
                  <div
                    key={file.path}
                    onClick={() => toggleSelect(file.path)}
                    onMouseEnter={() => isPreviewable(file.name) && loadThumbnail(file.path)}
                    className={`px-4 py-3 flex items-center gap-3 cursor-pointer transition-colors ${
                      selected.has(file.path)
                        ? "bg-red-50"
                        : fileIdx % 2 === 0
                        ? "bg-white"
                        : "bg-gray-50/50"
                    } hover:bg-blue-50`}
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(file.path)}
                      onChange={() => toggleSelect(file.path)}
                      className="w-4 h-4 rounded"
                    />
                    {/* 缩略图/图标 */}
                    <div 
                      className="w-10 h-10 flex-shrink-0 rounded overflow-hidden bg-gray-100 flex items-center justify-center cursor-pointer"
                      onClick={(e) => {
                        e.stopPropagation();
                        const thumb = thumbnails.get(file.path) || groupThumb;
                        if (thumb) setPreviewImage(thumb);
                      }}
                    >
                      {thumbnails.get(file.path) ? (
                        <img
                          src={thumbnails.get(file.path)}
                          alt=""
                          className="w-full h-full object-cover"
                        />
                      ) : groupThumb ? (
                        <img src={groupThumb} alt="" className="w-full h-full object-cover opacity-60" />
                      ) : (
                        <span className="text-xl">{getFileIcon(file.name)}</span>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate text-sm">{file.name}</div>
                      <div className="text-xs text-gray-400 truncate">{file.path}</div>
                    </div>
                    {fileIdx === 0 && (
                      <span className="text-xs px-2 py-1 bg-green-100 text-green-600 rounded">
                        最早
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
            );
          })}
        </div>
      )}

      {/* 图片预览弹窗 */}
      {previewImage && (
        <div 
          className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 cursor-pointer"
          onClick={() => setPreviewImage(null)}
        >
          <div className="relative max-w-[90vw] max-h-[90vh]">
            <img 
              src={previewImage} 
              alt="预览" 
              className="max-w-full max-h-[90vh] object-contain rounded-lg shadow-2xl"
            />
            <button 
              className="absolute -top-3 -right-3 w-8 h-8 bg-white rounded-full shadow-lg flex items-center justify-center text-gray-600 hover:text-gray-900"
              onClick={() => setPreviewImage(null)}
            >
              ✕
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
