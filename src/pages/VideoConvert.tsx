import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";

interface Props {
  active: boolean;
}

type Format = "mp4" | "mov" | "gif";
type Quality = "high" | "medium" | "low";

const FORMATS: { value: Format; label: string }[] = [
  { value: "mp4", label: "MP4" },
  { value: "mov", label: "MOV" },
  { value: "gif", label: "GIF" },
];

const QUALITIES: { value: Quality; label: string; desc: string }[] = [
  { value: "high", label: "高画质", desc: "文件较大" },
  { value: "medium", label: "均衡", desc: "推荐" },
  { value: "low", label: "小文件", desc: "画质一般" },
];

export default function VideoConvert({ active }: Props) {
  const [file, setFile] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [targetFormat, setTargetFormat] = useState<Format>("mp4");
  const [quality, setQuality] = useState<Quality>("medium");
  const [converting, setConverting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const unlisten = listen<number>("convert-progress", (event) => {
      setProgress(Math.round(event.payload));
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  useEffect(() => {
    if (!active || file) return;
    const unlistenEnter = listen("tauri://drag-enter", () => setDragging(true));
    const unlistenLeave = listen("tauri://drag-leave", () => setDragging(false));
    const unlistenDrop = listen<{ paths: string[] }>("tauri://drag-drop", (event) => {
      setDragging(false);
      if (event.payload.paths?.length > 0) handleFileSelect(event.payload.paths[0]);
    });
    return () => {
      unlistenEnter.then((fn) => fn());
      unlistenLeave.then((fn) => fn());
      unlistenDrop.then((fn) => fn());
    };
  }, [active, file]);

  const handleFileSelect = (path: string) => {
    setFile(path);
    setFileName(path.split("/").pop() || path.split("\\").pop() || "");
    setResult(null);
    const ext = path.split(".").pop()?.toLowerCase();
    if (ext === "mov") setTargetFormat("mp4");
    else if (ext === "mp4") setTargetFormat("mov");
  };

  const handleClick = async () => {
    const selected = await open({
      title: "选择视频文件",
      filters: [{ name: "视频", extensions: ["mov", "mp4", "avi", "mkv", "webm"] }],
    });
    if (selected) handleFileSelect(selected as string);
  };

  const handleConvert = async () => {
    if (!file) return;
    const baseName = fileName.replace(/\.[^.]+$/, "");
    const outputPath = await save({
      defaultPath: `${baseName}.${targetFormat}`,
      filters: [{ name: targetFormat.toUpperCase(), extensions: [targetFormat] }],
    });
    if (!outputPath) return;

    setConverting(true);
    setProgress(0);
    setResult(null);

    try {
      await invoke("convert_video", { 
        input: file, 
        output: outputPath, 
        format: targetFormat,
        quality: quality,
      });
      setResult({ success: true, message: outputPath.split("/").pop() || "转换成功" });
    } catch (e) {
      setResult({ success: false, message: String(e) });
    } finally {
      setConverting(false);
    }
  };

  const handleCancel = () => invoke("cancel_convert");
  const handleReset = () => { setFile(null); setFileName(""); setProgress(0); setResult(null); };

  const sourceFormat = fileName.split(".").pop()?.toLowerCase() || "";

  return (
    <div className="p-6">
      <div className="card">
        {!file ? (
          /* 拖拽上传区域 */
          <div
            onClick={handleClick}
            className={`p-16 border-2 border-dashed rounded-lg cursor-pointer transition-all text-center
              ${dragging ? "border-blue-400 bg-blue-50" : "border-gray-200 hover:border-blue-300"}`}
          >
            <div className="text-5xl mb-4">{dragging ? "📂" : "🎬"}</div>
            <div className="text-gray-500 mb-2">点击或拖拽视频文件到此处</div>
            <div className="text-xs text-gray-400">支持 MOV、MP4、AVI、MKV 等格式</div>
          </div>
        ) : result?.success ? (
          /* 转换成功 */
          <div className="p-12 text-center">
            <div className="w-16 h-16 mx-auto mb-4 bg-green-500 rounded-full flex items-center justify-center">
              <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <div className="text-lg font-medium text-gray-800 mb-2">转换成功</div>
            <div className="text-sm text-gray-400 mb-6 truncate max-w-xs mx-auto">{result.message}</div>
            <button onClick={handleReset} className="btn-primary px-6">继续转换</button>
          </div>
        ) : (
          /* 转换设置 */
          <div className="p-6">
            {/* 文件信息卡片 */}
            <div className="flex items-center gap-4 p-4 bg-gray-50 rounded-lg border border-gray-100 mb-6">
              <div className="w-12 h-12 bg-blue-500 rounded-lg flex items-center justify-center text-white text-xl flex-shrink-0">
                🎬
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-medium text-gray-800 truncate">{fileName}</div>
                <div className="text-xs text-gray-400 mt-1">源格式：{sourceFormat.toUpperCase()}</div>
              </div>
              {!converting && (
                <button onClick={handleReset} className="text-sm text-blue-500 hover:text-blue-600">更换</button>
              )}
            </div>

            {!converting && (
              <>
                {/* 目标格式 */}
                <div className="mb-5">
                  <label className="block text-sm font-medium text-gray-700 mb-2">目标格式</label>
                  <div className="flex gap-3">
                    {FORMATS.filter((f) => f.value !== sourceFormat).map((format) => (
                      <button
                        key={format.value}
                        onClick={() => setTargetFormat(format.value)}
                        className={`flex-1 py-3 px-4 rounded-lg border-2 text-sm font-medium transition-all
                          ${targetFormat === format.value
                            ? "border-blue-500 bg-blue-50 text-blue-600"
                            : "border-gray-200 text-gray-600 hover:border-gray-300"
                          }`}
                      >
                        {format.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* 画质选择 */}
                <div className="mb-6">
                  <label className="block text-sm font-medium text-gray-700 mb-2">画质</label>
                  <div className="flex gap-3">
                    {QUALITIES.map((q) => (
                      <button
                        key={q.value}
                        onClick={() => setQuality(q.value)}
                        className={`flex-1 py-3 px-4 rounded-lg border-2 transition-all text-center
                          ${quality === q.value
                            ? "border-blue-500 bg-blue-50"
                            : "border-gray-200 hover:border-gray-300"
                          }`}
                      >
                        <div className={`text-sm font-medium ${quality === q.value ? "text-blue-600" : "text-gray-700"}`}>
                          {q.label}
                        </div>
                        <div className="text-xs text-gray-400 mt-0.5">{q.desc}</div>
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}

            {/* 转换进度 */}
            {converting && (
              <div className="mb-6 p-4 bg-blue-50 rounded-lg border border-blue-100">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                    <span className="text-sm font-medium text-blue-600">正在转换</span>
                  </div>
                  <span className="text-sm font-bold text-blue-600">{progress}%</span>
                </div>
                <div className="h-2 bg-blue-100 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-blue-500 rounded-full transition-all duration-300"
                    style={{ width: `${progress}%` }}
                  />
                </div>
              </div>
            )}

            {/* 错误提示 */}
            {result && !result.success && (
              <div className="mb-6 p-4 bg-red-50 rounded-lg border border-red-100 flex items-start gap-3">
                <span className="text-red-500">⚠️</span>
                <span className="text-sm text-red-600">{result.message}</span>
              </div>
            )}

            {/* 操作按钮 */}
            {converting ? (
              <button onClick={handleCancel} className="btn-secondary w-full">取消转换</button>
            ) : (
              <button onClick={handleConvert} className="btn-primary w-full">开始转换</button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
