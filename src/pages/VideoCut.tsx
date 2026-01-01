import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";

interface VideoInfo {
  duration: number;
  width: number;
  height: number;
  fps: number;
}

interface DragDropPayload {
  paths: string[];
}

export default function VideoCut({ active = true }: { active?: boolean }) {
  const [videoPath, setVideoPath] = useState("");
  const [videoInfo, setVideoInfo] = useState<VideoInfo | null>(null);
  const [startTime, setStartTime] = useState(0);
  const [endTime, setEndTime] = useState(0);
  const [processing, setProcessing] = useState(false);
  const [preciseMode, setPreciseMode] = useState(false);
  const [dragging, setDragging] = useState(false);
  
  // 预览相关
  const [previewFrame, setPreviewFrame] = useState<string>("");
  const [timelineFrames, setTimelineFrames] = useState<string[]>([]);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [currentPreviewTime, setCurrentPreviewTime] = useState(0);
  const previewTimeoutRef = useRef<number | null>(null);
  
  // 时间输入框状态（独立管理，避免编辑时被格式化干扰）
  const [startTimeInput, setStartTimeInput] = useState("");
  const [endTimeInput, setEndTimeInput] = useState("");
  const [editingStart, setEditingStart] = useState(false);
  const [editingEnd, setEditingEnd] = useState(false);
  
  // 进度相关
  const [progress, setProgress] = useState(0);

  // 监听拖拽事件
  useEffect(() => {
    // 非激活状态不监听
    if (!active) {
      setDragging(false);
      return;
    }

    const unlistenEnter = listen<DragDropPayload>("tauri://drag-enter", () => {
      setDragging(true);
    });
    const unlistenLeave = listen("tauri://drag-leave", () => {
      setDragging(false);
    });
    const unlistenDrop = listen<DragDropPayload>("tauri://drag-drop", (event) => {
      setDragging(false);
      if (!active) return;
      const paths = event.payload.paths;
      if (paths && paths.length > 0) {
        const file = paths[0];
        const ext = file.split(".").pop()?.toLowerCase();
        if (["mp4", "mov", "avi", "mkv", "wmv", "flv", "webm"].includes(ext || "")) {
          loadVideo(file);
        }
      }
    });

    return () => {
      unlistenEnter.then((fn) => fn());
      unlistenLeave.then((fn) => fn());
      unlistenDrop.then((fn) => fn());
    };
  }, [active]);

  // 监听视频处理进度
  useEffect(() => {
    const unlisten = listen<number>("video-progress", (event) => {
      setProgress(event.payload);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  async function loadVideo(path: string) {
    setVideoPath(path);
    setPreviewFrame("");
    setTimelineFrames([]);
    
    try {
      const info = await invoke<VideoInfo>("get_video_info", { path });
      setVideoInfo(info);
      setStartTime(0);
      setEndTime(info.duration);
      setCurrentPreviewTime(0);
      
      // 生成初始预览帧
      loadPreviewFrame(path, 0);
      
      // 生成时间轴缩略图
      loadTimelineFrames(path);
    } catch (e) {
      alert("获取视频信息失败: " + e);
    }
  }

  async function loadPreviewFrame(path: string, time: number) {
    setLoadingPreview(true);
    try {
      const frame = await invoke<string>("generate_preview_frame", { path, time });
      setPreviewFrame(frame);
      setCurrentPreviewTime(time);
    } catch (e) {
      console.error("生成预览帧失败:", e);
    } finally {
      setLoadingPreview(false);
    }
  }

  async function loadTimelineFrames(path: string) {
    try {
      const frames = await invoke<string[]>("generate_timeline_frames", { path, count: 8 });
      setTimelineFrames(frames);
    } catch (e) {
      console.error("生成时间轴失败:", e);
    }
  }

  // 防抖更新预览帧
  function updatePreviewDebounced(time: number) {
    if (previewTimeoutRef.current) {
      clearTimeout(previewTimeoutRef.current);
    }
    previewTimeoutRef.current = window.setTimeout(() => {
      if (videoPath) {
        loadPreviewFrame(videoPath, time);
      }
    }, 300);
  }

  async function selectVideo() {
    const file = await open({
      title: "选择视频文件",
      filters: [
        { name: "视频文件", extensions: ["mp4", "mov", "avi", "mkv", "wmv", "flv", "webm"] },
      ],
    });
    if (file && typeof file === "string") {
      loadVideo(file);
    }
  }

  async function handleCut() {
    if (!videoPath || !videoInfo) return;

    const ext = videoPath.split(".").pop() || "mp4";
    const baseName = videoPath.split("/").pop()?.replace(/\.[^.]+$/, "") || "video";
    const timestamp = Date.now();
    const defaultName = `${baseName}-${timestamp}.${ext}`;

    const outputPath = await save({
      title: "保存截取的视频",
      defaultPath: defaultName,
      filters: [{ name: "视频文件", extensions: [ext, "mp4"] }],
    });
    if (!outputPath) return;

    setProcessing(true);
    setProgress(0);
    try {
      const cmd = preciseMode ? "cut_video_precise" : "cut_video";
      await invoke(cmd, {
        input: videoPath,
        output: outputPath,
        startTime,
        endTime,
      });
      alert("截取完成！");
    } catch (e) {
      const msg = String(e);
      if (!msg.includes("取消")) {
        alert("截取失败: " + e);
      }
    } finally {
      setProcessing(false);
      setProgress(0);
    }
  }

  async function cancelCut() {
    await invoke("cancel_video_cut");
    setProcessing(false);
    setProgress(0);
  }  function formatTime(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 10);
    if (h > 0) {
      return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}.${ms}`;
    }
    return `${m}:${s.toString().padStart(2, "0")}.${ms}`;
  }

  function parseTimeInput(str: string): number {
    const parts = str.split(":").map((p) => parseFloat(p) || 0);
    if (parts.length === 3) {
      return parts[0] * 3600 + parts[1] * 60 + parts[2];
    } else if (parts.length === 2) {
      return parts[0] * 60 + parts[1];
    }
    return parts[0] || 0;
  }

  const clipDuration = Math.max(0, endTime - startTime);

  return (
    <div className="p-6 space-y-6">
      {!videoPath ? (
        <div className="card p-6">
          <div
            onClick={selectVideo}
            className={`drop-zone ${dragging ? "dragging" : ""}`}
          >
            <div className="text-5xl mb-4">{dragging ? "📂" : "🎬"}</div>
            <div className="text-base text-gray-600 mb-2">
              {dragging ? "松开以选择视频" : "拖入视频文件 或 点击选择"}
            </div>
            <div className="text-sm text-gray-400">
              支持 MP4、MOV、AVI、MKV 等格式
            </div>
          </div>
        </div>
      ) : (
        <>
          {/* 视频预览区域 */}
          <div className="card overflow-hidden">
            <div className="bg-black relative" style={{ minHeight: "300px" }}>
              {previewFrame ? (
                <img
                  src={previewFrame}
                  alt="视频预览"
                  className="w-full h-auto max-h-[400px] object-contain mx-auto"
                />
              ) : (
                <div className="flex items-center justify-center h-[300px] text-gray-500">
                  {loadingPreview ? "⏳ 加载预览中..." : "🎬 视频预览"}
                </div>
              )}
              {loadingPreview && previewFrame && (
                <div className="absolute top-2 right-2 bg-black/50 text-white px-2 py-1 rounded text-sm">
                  ⏳ 更新中...
                </div>
              )}
              {/* 当前预览时间 */}
              <div className="absolute bottom-2 left-2 bg-black/70 text-white px-3 py-1 rounded text-sm font-mono">
                {formatTime(currentPreviewTime)}
              </div>
              {/* 更换按钮 */}
              <button
                onClick={selectVideo}
                className="absolute top-2 left-2 bg-black/50 hover:bg-black/70 text-white px-3 py-1 rounded text-sm"
              >
                🔄 更换视频
              </button>
            </div>

            {/* 时间轴缩略图 */}
            {timelineFrames.length > 0 && (
              <div className="bg-gray-900 p-2">
                <div className="flex gap-1">
                  {timelineFrames.map((frame, i) => {
                    const frameTime = videoInfo ? (videoInfo.duration / (timelineFrames.length + 1)) * (i + 1) : 0;
                    return (
                      <div
                        key={i}
                        className="flex-1 cursor-pointer hover:opacity-80 transition-opacity relative group"
                        onClick={() => {
                          setCurrentPreviewTime(frameTime);
                          loadPreviewFrame(videoPath, frameTime);
                        }}
                      >
                        <img src={frame} alt="" className="w-full h-12 object-cover rounded" />
                        <div className="absolute bottom-0 left-0 right-0 bg-black/60 text-white text-xs text-center opacity-0 group-hover:opacity-100 transition-opacity">
                          {formatTime(frameTime)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* 视频信息 */}
            {videoInfo && (
              <div className="p-3 bg-gray-50 flex items-center justify-between text-sm text-gray-600">
                <span className="truncate flex-1" title={videoPath}>
                  📁 {videoPath.split("/").pop()}
                </span>
                <div className="flex gap-4 ml-4">
                  <span>📐 {videoInfo.width}×{videoInfo.height}</span>
                  <span>⏱️ {formatTime(videoInfo.duration)}</span>
                  <span>🎞️ {videoInfo.fps.toFixed(1)}fps</span>
                </div>
              </div>
            )}
          </div>

          {/* 时间选择滑块 */}
          {videoInfo && (
            <div className="card p-4">
              <div className="mb-4">
                <div className="text-sm text-gray-500 mb-2">预览位置（拖动查看不同时间点）</div>
                <input
                  type="range"
                  min={0}
                  max={videoInfo.duration}
                  step={0.1}
                  value={currentPreviewTime}
                  onChange={(e) => {
                    const t = parseFloat(e.target.value);
                    setCurrentPreviewTime(t);
                    updatePreviewDebounced(t);
                  }}
                  className="w-full"
                />
              </div>
              
              {/* 截取范围可视化 */}
              <div className="relative h-8 bg-gray-200 rounded-lg mb-4 overflow-hidden">
                {/* 时间轴背景 */}
                {timelineFrames.length > 0 && (
                  <div className="absolute inset-0 flex">
                    {timelineFrames.map((frame, i) => (
                      <div key={i} className="flex-1">
                        <img src={frame} alt="" className="w-full h-full object-cover opacity-50" />
                      </div>
                    ))}
                  </div>
                )}
                {/* 选中区域 */}
                <div
                  className="absolute h-full bg-blue-500/60 border-x-2 border-blue-600"
                  style={{
                    left: `${(startTime / videoInfo.duration) * 100}%`,
                    width: `${(clipDuration / videoInfo.duration) * 100}%`,
                  }}
                />
                {/* 当前预览位置 */}
                <div
                  className="absolute w-0.5 h-full bg-yellow-400"
                  style={{ left: `${(currentPreviewTime / videoInfo.duration) * 100}%` }}
                />
              </div>
            </div>
          )}

          {/* 截取控制 */}
          <div className="card p-6">
            <div className="grid grid-cols-3 gap-8 mb-6">
              <div>
                <div className="text-sm text-gray-500 mb-2 text-center">开始时间</div>
                <input
                  type="text"
                  value={editingStart ? startTimeInput : formatTime(startTime)}
                  onFocus={() => {
                    setEditingStart(true);
                    setStartTimeInput(formatTime(startTime));
                  }}
                  onChange={(e) => setStartTimeInput(e.target.value)}
                  onBlur={() => {
                    setEditingStart(false);
                    const t = parseTimeInput(startTimeInput);
                    if (t >= 0 && t <= (videoInfo?.duration || 0)) {
                      setStartTime(t);
                      if (t > endTime) setEndTime(t);
                      // 跳转到该时间点预览
                      loadPreviewFrame(videoPath, t);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      (e.target as HTMLInputElement).blur();
                    }
                  }}
                  placeholder="0:00"
                  className="w-full text-center text-2xl font-mono text-green-600 border-2 border-green-200 rounded-lg p-3 focus:border-green-500 focus:outline-none"
                />
                {videoInfo && (
                  <input
                    type="range"
                    min={0}
                    max={videoInfo.duration}
                    step={0.1}
                    value={startTime}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      setStartTime(v);
                      if (v > endTime) setEndTime(v);
                      updatePreviewDebounced(v);
                    }}
                    className="w-full mt-2"
                  />
                )}
                <button
                  onClick={() => {
                    setStartTime(currentPreviewTime);
                  }}
                  className="w-full mt-2 text-sm text-green-600 hover:bg-green-50 py-1 rounded"
                >
                  ⬆️ 设为当前位置
                </button>
              </div>

              <div>
                <div className="text-sm text-gray-500 mb-2 text-center">截取时长</div>
                <div className="text-center text-2xl font-mono text-blue-600 border-2 border-blue-200 rounded-lg p-3 bg-blue-50">
                  {formatTime(clipDuration)}
                </div>
                <div className="text-center text-xs text-gray-400 mt-2">
                  {clipDuration > 0 ? `约 ${Math.round(clipDuration)} 秒` : "请设置时间范围"}
                </div>
              </div>

              <div>
                <div className="text-sm text-gray-500 mb-2 text-center">结束时间</div>
                <input
                  type="text"
                  value={editingEnd ? endTimeInput : formatTime(endTime)}
                  onFocus={() => {
                    setEditingEnd(true);
                    setEndTimeInput(formatTime(endTime));
                  }}
                  onChange={(e) => setEndTimeInput(e.target.value)}
                  onBlur={() => {
                    setEditingEnd(false);
                    const t = parseTimeInput(endTimeInput);
                    if (t >= 0 && t <= (videoInfo?.duration || 0)) {
                      setEndTime(t);
                      if (t < startTime) setStartTime(t);
                      // 跳转到该时间点预览
                      loadPreviewFrame(videoPath, t);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      (e.target as HTMLInputElement).blur();
                    }
                  }}
                  placeholder="0:00"
                  className="w-full text-center text-2xl font-mono text-red-600 border-2 border-red-200 rounded-lg p-3 focus:border-red-500 focus:outline-none"
                />
                {videoInfo && (
                  <input
                    type="range"
                    min={0}
                    max={videoInfo.duration}
                    step={0.1}
                    value={endTime}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      setEndTime(v);
                      if (v < startTime) setStartTime(v);
                      updatePreviewDebounced(v);
                    }}
                    className="w-full mt-2"
                  />
                )}
                <button
                  onClick={() => {
                    setEndTime(currentPreviewTime);
                  }}
                  className="w-full mt-2 text-sm text-red-600 hover:bg-red-50 py-1 rounded"
                >
                  ⬆️ 设为当前位置
                </button>
              </div>
            </div>

            <div className="flex items-center justify-between pt-4 border-t">
              <label className="flex items-center gap-2 text-sm text-gray-600">
                <input
                  type="checkbox"
                  checked={preciseMode}
                  onChange={(e) => setPreciseMode(e.target.checked)}
                  className="w-4 h-4"
                />
                精确模式（重新编码，较慢但时间精确）
              </label>

              <button
                onClick={handleCut}
                disabled={processing || clipDuration <= 0}
                className="btn btn-primary px-8"
              >
                {processing ? "⏳ 处理中..." : "✂️ 开始截取"}
              </button>
            </div>

            {/* 处理进度条 */}
            {processing && preciseMode && (
              <div className="mt-4 pt-4 border-t">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm text-gray-600">正在编码...</span>
                  <div className="flex items-center gap-4">
                    <span className="text-sm font-mono text-blue-600">
                      {progress.toFixed(1)}%
                    </span>
                    <button
                      onClick={cancelCut}
                      className="text-sm text-red-500 hover:text-red-700"
                    >
                      ✕ 取消
                    </button>
                  </div>
                </div>
                <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-blue-500 transition-all duration-300"
                    style={{ width: `${progress}%` }}
                  />
                </div>
              </div>
            )}
          </div>

          <div className="card p-4 bg-blue-50 border border-blue-200">
            <div className="text-sm text-blue-700">
              💡 <strong>提示：</strong>
              拖动预览滑块查看不同时间点的画面，点击时间轴缩略图快速跳转。
              使用"设为当前位置"按钮可以精确设置开始/结束时间。
            </div>
          </div>
        </>
      )}
    </div>
  );
}
