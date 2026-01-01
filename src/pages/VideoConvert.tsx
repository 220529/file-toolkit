import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

interface Props {
  active: boolean;
}

type Format = "mp4" | "mov" | "gif";
type Quality = "high" | "medium" | "low";
type FileStatus = "pending" | "converting" | "done" | "error";

interface FileItem {
  id: string;
  path: string;
  name: string;
  sourceFormat: string;
  status: FileStatus;
  progress: number;
  error?: string;
  outputPath?: string;
}

const FORMATS: { value: Format; label: string }[] = [
  { value: "mp4", label: "MP4" },
  { value: "mov", label: "MOV" },
  { value: "gif", label: "GIF" },
];

const QUALITIES: { value: Quality; label: string }[] = [
  { value: "high", label: "高画质" },
  { value: "medium", label: "均衡" },
  { value: "low", label: "小文件" },
];

export default function VideoConvert({ active }: Props) {
  const [files, setFiles] = useState<FileItem[]>([]);
  const [targetFormat, setTargetFormat] = useState<Format>("mp4");
  const [quality, setQuality] = useState<Quality>("medium");
  const [converting, setConverting] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const unlisten = listen<number>("convert-progress", (event) => {
      if (currentIndex >= 0) {
        setFiles(prev => prev.map((f, i) => 
          i === currentIndex ? { ...f, progress: Math.round(event.payload) } : f
        ));
      }
    });
    return () => { unlisten.then(fn => fn()); };
  }, [currentIndex]);

  useEffect(() => {
    if (!active) return;
    const unlistenEnter = listen("tauri://drag-enter", () => setDragging(true));
    const unlistenLeave = listen("tauri://drag-leave", () => setDragging(false));
    const unlistenDrop = listen<{ paths: string[] }>("tauri://drag-drop", (event) => {
      setDragging(false);
      if (event.payload.paths?.length > 0) {
        addFiles(event.payload.paths);
      }
    });
    return () => {
      unlistenEnter.then(fn => fn());
      unlistenLeave.then(fn => fn());
      unlistenDrop.then(fn => fn());
    };
  }, [active, files]);

  const addFiles = (paths: string[]) => {
    const videoExts = ["mov", "mp4", "avi", "mkv", "webm", "flv", "wmv"];
    const newFiles: FileItem[] = paths
      .filter(p => {
        const ext = p.split(".").pop()?.toLowerCase() || "";
        return videoExts.includes(ext) && !files.some(f => f.path === p);
      })
      .map(p => ({
        id: Math.random().toString(36).slice(2),
        path: p,
        name: p.split("/").pop() || p.split("\\").pop() || "",
        sourceFormat: p.split(".").pop()?.toLowerCase() || "",
        status: "pending" as FileStatus,
        progress: 0,
      }));
    if (newFiles.length > 0) {
      setFiles(prev => [...prev, ...newFiles]);
    }
  };

  const handleSelectFiles = async () => {
    const selected = await open({
      title: "选择视频文件",
      multiple: true,
      filters: [{ name: "视频", extensions: ["mov", "mp4", "avi", "mkv", "webm"] }],
    });
    if (selected) {
      addFiles(Array.isArray(selected) ? selected : [selected]);
    }
  };

  const removeFile = (id: string) => {
    setFiles(prev => prev.filter(f => f.id !== id));
  };

  const startConvert = async () => {
    const pendingFiles = files.filter(f => f.status === "pending");
    if (pendingFiles.length === 0) return;

    setConverting(true);

    for (let i = 0; i < files.length; i++) {
      if (files[i].status !== "pending") continue;
      
      setCurrentIndex(i);
      setFiles(prev => prev.map((f, idx) => 
        idx === i ? { ...f, status: "converting", progress: 0 } : f
      ));

      const file = files[i];
      const baseName = file.name.replace(/\.[^.]+$/, "");
      const dir = file.path.substring(0, file.path.lastIndexOf("/") + 1);
      const outputPath = `${dir}${baseName}_converted.${targetFormat}`;

      try {
        await invoke("convert_video", {
          input: file.path,
          output: outputPath,
          format: targetFormat,
          quality: quality,
        });
        setFiles(prev => prev.map((f, idx) => 
          idx === i ? { ...f, status: "done", progress: 100, outputPath } : f
        ));
      } catch (e) {
        setFiles(prev => prev.map((f, idx) => 
          idx === i ? { ...f, status: "error", error: String(e) } : f
        ));
      }
    }

    setConverting(false);
    setCurrentIndex(-1);
  };

  const handleCancel = () => {
    invoke("cancel_convert");
    setConverting(false);
  };

  const doneCount = files.filter(f => f.status === "done").length;
  const errorCount = files.filter(f => f.status === "error").length;
  const pendingCount = files.filter(f => f.status === "pending").length;

  return (
    <div className="p-6 space-y-6">
      {/* 拖拽选择区域 */}
      <div className="card p-6">
        <div
          onClick={handleSelectFiles}
          className={`drop-zone ${dragging && active ? "dragging" : ""}`}
        >
          <div className="text-5xl mb-4">
            {converting ? "⏳" : dragging ? "📂" : "🎬"}
          </div>
          <div className="text-base text-gray-600 mb-2">
            {converting ? "转换中，请稍候..." : dragging ? "松开以添加视频" : "拖入视频 或 点击选择"}
          </div>
          <div className="text-sm text-gray-400">
            支持 MOV、MP4、AVI、MKV 等格式，可批量添加
          </div>
        </div>

        {files.length > 0 && (
          <div className="mt-4 px-3 py-2 bg-gray-50 rounded text-sm text-gray-500">
            已选择 {files.length} 个视频
            {doneCount > 0 && <span className="text-green-600 ml-2">✓ {doneCount} 完成</span>}
            {errorCount > 0 && <span className="text-red-500 ml-2">✕ {errorCount} 失败</span>}
          </div>
        )}
      </div>

      {/* 设置和文件列表 */}
      {files.length > 0 && (
        <div className="grid grid-cols-3 gap-6">
          {/* 左侧：文件列表 */}
          <div className="col-span-2 card">
            <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
              <span className="font-medium">文件列表</span>
              {!converting && (
                <button onClick={handleSelectFiles} className="text-sm text-blue-500 hover:text-blue-600">
                  + 添加更多
                </button>
              )}
            </div>
            <div className="max-h-80 overflow-auto">
              {files.map((file, index) => (
                <div
                  key={file.id}
                  className={`flex items-center gap-3 px-4 py-3 border-b border-gray-50 last:border-0
                    ${file.status === "converting" ? "bg-blue-50" : 
                      file.status === "done" ? "bg-green-50" :
                      file.status === "error" ? "bg-red-50" : ""}`}
                >
                  <div className="w-6 h-6 rounded bg-gray-100 flex items-center justify-center text-xs text-gray-500 flex-shrink-0">
                    {index + 1}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm truncate">{file.name}</div>
                    {file.status === "converting" && (
                      <div className="mt-1.5 h-1.5 bg-blue-100 rounded-full overflow-hidden">
                        <div className="h-full bg-blue-500 rounded-full transition-all" style={{ width: `${file.progress}%` }} />
                      </div>
                    )}
                    {file.status === "error" && (
                      <div className="text-xs text-red-500 mt-0.5 truncate">{file.error}</div>
                    )}
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {file.status === "pending" && <span className="text-xs text-gray-400">等待中</span>}
                    {file.status === "converting" && <span className="text-xs text-blue-500 font-medium">{file.progress}%</span>}
                    {file.status === "done" && <span className="text-xs text-green-600">✓ 完成</span>}
                    {file.status === "error" && <span className="text-xs text-red-500">失败</span>}
                    {!converting && file.status !== "converting" && (
                      <button onClick={() => removeFile(file.id)} className="w-6 h-6 rounded hover:bg-gray-200 flex items-center justify-center text-gray-400 hover:text-gray-600">×</button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* 右侧：设置面板 */}
          <div className="card p-4 space-y-4">
            <div>
              <div className="text-sm font-medium mb-3">输出格式</div>
              <div className="grid grid-cols-3 gap-2">
                {FORMATS.map(f => (
                  <button
                    key={f.value}
                    onClick={() => !converting && setTargetFormat(f.value)}
                    disabled={converting}
                    className={`btn text-sm py-1.5 ${targetFormat === f.value ? "btn-primary" : "btn-default"}`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div className="text-sm font-medium mb-3">画质</div>
              <div className="grid grid-cols-3 gap-2">
                {QUALITIES.map(q => (
                  <button
                    key={q.value}
                    onClick={() => !converting && setQuality(q.value)}
                    disabled={converting}
                    className={`btn text-sm py-1.5 ${quality === q.value ? "btn-primary" : "btn-default"}`}
                  >
                    {q.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="pt-4 space-y-2">
              {!converting ? (
                <>
                  <button
                    onClick={startConvert}
                    disabled={pendingCount === 0}
                    className="btn btn-primary w-full"
                  >
                    开始转换 {pendingCount > 0 && `(${pendingCount})`}
                  </button>
                  <button
                    onClick={() => setFiles([])}
                    className="btn btn-default w-full"
                  >
                    清空
                  </button>
                </>
              ) : (
                <button onClick={handleCancel} className="btn btn-danger w-full">
                  取消转换
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
