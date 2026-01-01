import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";

interface ImageInfo {
  width: number;
  height: number;
  path: string;
  thumbnail: string;
}

interface Result {
  success: boolean;
  output_path: string;
  message: string;
}

interface Props {
  active: boolean;
}

type DragMode = "none" | "move" | "create" | "nw" | "ne" | "sw" | "se" | "n" | "s" | "e" | "w";
type RemoveMode = "blur" | "fill";

export default function Watermark({ active }: Props) {
  const [image, setImage] = useState<ImageInfo | null>(null);
  const [rect, setRect] = useState({ x: 0, y: 0, w: 100, h: 30 });
  const [fillColor, setFillColor] = useState("#ffffff");
  const [processing, setProcessing] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [removeMode, setRemoveMode] = useState<RemoveMode>("blur");
  
  const [dragMode, setDragMode] = useState<DragMode>("none");
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [rectStart, setRectStart] = useState({ x: 0, y: 0, w: 0, h: 0 });
  
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [scale, setScale] = useState(1);
  const imgRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    if (!active) return;
    const unlistenEnter = listen("tauri://drag-enter", () => setDragging(true));
    const unlistenLeave = listen("tauri://drag-leave", () => setDragging(false));
    const unlistenDrop = listen<{ paths: string[] }>("tauri://drag-drop", async (event) => {
      setDragging(false);
      if (event.payload.paths?.length > 0) await loadImage(event.payload.paths[0]);
    });
    return () => {
      unlistenEnter.then(fn => fn());
      unlistenLeave.then(fn => fn());
      unlistenDrop.then(fn => fn());
    };
  }, [active]);

  const loadImage = async (path: string) => {
    const ext = path.split(".").pop()?.toLowerCase() || "";
    if (!["png", "jpg", "jpeg", "webp"].includes(ext)) return;
    setLoading(true);
    try {
      const info = await invoke<ImageInfo>("get_image_info", { path });
      setImage(info);
      setResult(null);
      // 默认选区在右下角（常见水印位置）
      setRect({ x: info.width - 120, y: info.height - 40, w: 100, h: 30 });
    } catch (e) {
      console.error("加载图片失败:", e);
    }
    setLoading(false);
  };

  const handleSelectFile = async () => {
    const selected = await open({
      multiple: false,
      filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp"] }],
    });
    if (selected && typeof selected === "string") await loadImage(selected);
  };

  // 加载图片到 canvas
  useEffect(() => {
    if (!image || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      const maxW = 560, maxH = 420;
      let w = image.width, h = image.height;
      const s = Math.min(maxW / w, maxH / h, 1);
      w *= s; h *= s;
      setScale(s);
      canvas.width = w;
      canvas.height = h;
      ctx.drawImage(img, 0, 0, w, h);
    };
    img.src = image.thumbnail;
  }, [image]);

  // 重绘画布
  useEffect(() => {
    if (!image || !canvasRef.current || !imgRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(imgRef.current, 0, 0, canvas.width, canvas.height);
    
    const x = rect.x * scale, y = rect.y * scale;
    const w = rect.w * scale, h = rect.h * scale;
    
    // 预览效果
    if (removeMode === "fill") {
      ctx.fillStyle = fillColor + "aa";
      ctx.fillRect(x, y, w, h);
    } else {
      // 模糊预览用半透明遮罩表示
      ctx.fillStyle = "rgba(128,128,128,0.4)";
      ctx.fillRect(x, y, w, h);
    }
    
    // 选区边框
    ctx.strokeStyle = "#1677ff";
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 3]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
    
    // 四角 + 四边控制点
    const size = 8;
    ctx.fillStyle = "#1677ff";
    const points = [
      [x, y], [x + w, y], [x, y + h], [x + w, y + h],
      [x + w/2, y], [x + w/2, y + h], [x, y + h/2], [x + w, y + h/2]
    ];
    points.forEach(([px, py]) => {
      ctx.fillRect(px - size/2, py - size/2, size, size);
    });
  }, [image, rect, scale, fillColor, removeMode]);

  // 判断点击位置
  const getHitArea = (mx: number, my: number): DragMode => {
    const x = rect.x * scale, y = rect.y * scale;
    const w = rect.w * scale, h = rect.h * scale;
    const m = 10;

    if (Math.abs(mx - x) < m && Math.abs(my - y) < m) return "nw";
    if (Math.abs(mx - (x + w)) < m && Math.abs(my - y) < m) return "ne";
    if (Math.abs(mx - x) < m && Math.abs(my - (y + h)) < m) return "sw";
    if (Math.abs(mx - (x + w)) < m && Math.abs(my - (y + h)) < m) return "se";
    if (Math.abs(my - y) < m && mx > x && mx < x + w) return "n";
    if (Math.abs(my - (y + h)) < m && mx > x && mx < x + w) return "s";
    if (Math.abs(mx - x) < m && my > y && my < y + h) return "w";
    if (Math.abs(mx - (x + w)) < m && my > y && my < y + h) return "e";
    if (mx > x && mx < x + w && my > y && my < y + h) return "move";
    return "create";
  };

  const getCursor = (mode: DragMode): string => {
    const map: Record<DragMode, string> = {
      none: "default", move: "move", create: "crosshair",
      nw: "nw-resize", ne: "ne-resize", sw: "sw-resize", se: "se-resize",
      n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize",
    };
    return map[mode];
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (!canvasRef.current) return;
    const r = canvasRef.current.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;

    // 颜色覆盖模式：右键取色
    if (removeMode === "fill" && e.button === 2) {
      const ctx = canvasRef.current.getContext("2d");
      if (ctx) {
        const pixel = ctx.getImageData(Math.round(mx), Math.round(my), 1, 1).data;
        setFillColor("#" + [pixel[0], pixel[1], pixel[2]].map(v => v.toString(16).padStart(2, "0")).join(""));
      }
      return;
    }

    const mode = getHitArea(mx, my);
    setDragMode(mode);
    setDragStart({ x: mx, y: my });
    setRectStart({ ...rect });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!canvasRef.current || !image) return;
    const r = canvasRef.current.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;

    if (dragMode === "none") {
      canvasRef.current.style.cursor = getCursor(getHitArea(mx, my));
      return;
    }

    const dx = (mx - dragStart.x) / scale;
    const dy = (my - dragStart.y) / scale;
    let newRect = { ...rectStart };

    switch (dragMode) {
      case "move":
        newRect.x = Math.max(0, Math.min(image.width - newRect.w, rectStart.x + dx));
        newRect.y = Math.max(0, Math.min(image.height - newRect.h, rectStart.y + dy));
        break;
      case "create":
        newRect = {
          x: Math.min(dragStart.x / scale, mx / scale),
          y: Math.min(dragStart.y / scale, my / scale),
          w: Math.abs(dx),
          h: Math.abs(dy),
        };
        break;
      case "se": newRect.w = Math.max(20, rectStart.w + dx); newRect.h = Math.max(20, rectStart.h + dy); break;
      case "sw": newRect.x = rectStart.x + dx; newRect.w = Math.max(20, rectStart.w - dx); newRect.h = Math.max(20, rectStart.h + dy); break;
      case "ne": newRect.w = Math.max(20, rectStart.w + dx); newRect.y = rectStart.y + dy; newRect.h = Math.max(20, rectStart.h - dy); break;
      case "nw": newRect.x = rectStart.x + dx; newRect.y = rectStart.y + dy; newRect.w = Math.max(20, rectStart.w - dx); newRect.h = Math.max(20, rectStart.h - dy); break;
      case "n": newRect.y = rectStart.y + dy; newRect.h = Math.max(20, rectStart.h - dy); break;
      case "s": newRect.h = Math.max(20, rectStart.h + dy); break;
      case "w": newRect.x = rectStart.x + dx; newRect.w = Math.max(20, rectStart.w - dx); break;
      case "e": newRect.w = Math.max(20, rectStart.w + dx); break;
    }

    setRect({
      x: Math.round(Math.max(0, newRect.x)),
      y: Math.round(Math.max(0, newRect.y)),
      w: Math.round(Math.max(20, newRect.w)),
      h: Math.round(Math.max(20, newRect.h)),
    });
  };

  const handleMouseUp = () => setDragMode("none");

  const handleRemove = async () => {
    if (!image) return;
    setProcessing(true);
    setResult(null);
    try {
      const res = await invoke<Result>("remove_watermark", {
        inputPath: image.path,
        x: rect.x, y: rect.y, width: rect.w, height: rect.h,
        color: fillColor,
        mode: removeMode,
        brushStrokes: [],
        brushSize: 0,
      });
      setResult(res);
    } catch (e) {
      setResult({ success: false, output_path: "", message: String(e) });
    }
    setProcessing(false);
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    handleMouseDown(e);
  };

  return (
    <div className="p-6 space-y-6">
      <div className="card p-6">
        <div onClick={handleSelectFile} className={`drop-zone ${dragging ? "dragging" : ""}`}>
          <div className="text-5xl mb-4">{loading ? "⏳" : "✨"}</div>
          <div className="text-base text-gray-600 mb-2">拖入图片 或 点击选择</div>
          <div className="text-sm text-gray-400">框选水印区域，一键去除</div>
        </div>
      </div>

      {image && (
        <div className="card p-5">
          <div className="flex gap-6">
            {/* 左侧：图片预览 */}
            <div className="flex-1">
              <div className="bg-gray-100 rounded-lg p-3 flex items-center justify-center">
                <canvas
                  ref={canvasRef}
                  onMouseDown={handleMouseDown}
                  onMouseMove={handleMouseMove}
                  onMouseUp={handleMouseUp}
                  onMouseLeave={handleMouseUp}
                  onContextMenu={handleContextMenu}
                />
              </div>
              <div className="mt-2 text-xs text-gray-400 text-center">
                拖动框选水印 · 拖动边角调整大小{removeMode === "fill" && " · 右键取色"}
              </div>
            </div>

            {/* 右侧：操作面板 */}
            <div className="w-52 flex-shrink-0 space-y-4">
              <div>
                <div className="text-sm text-gray-500 mb-2">去除方式</div>
                <div className="space-y-2">
                  <button
                    onClick={() => setRemoveMode("blur")}
                    className={`w-full py-2 px-3 rounded-lg text-sm text-left transition ${
                      removeMode === "blur" ? "bg-blue-500 text-white" : "bg-gray-100 hover:bg-gray-200"
                    }`}
                  >
                    <span className="mr-2">◐</span>高斯模糊
                  </button>
                  <button
                    onClick={() => setRemoveMode("fill")}
                    className={`w-full py-2 px-3 rounded-lg text-sm text-left transition ${
                      removeMode === "fill" ? "bg-blue-500 text-white" : "bg-gray-100 hover:bg-gray-200"
                    }`}
                  >
                    <span className="mr-2">■</span>颜色覆盖
                  </button>
                </div>
              </div>

              {removeMode === "fill" && (
                <div>
                  <div className="text-sm text-gray-500 mb-2">覆盖颜色</div>
                  <div className="flex items-center gap-2 mb-2">
                    <div className="relative flex-shrink-0">
                      <input
                        type="color"
                        value={fillColor}
                        onChange={(e) => setFillColor(e.target.value)}
                        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                      />
                      <div 
                        className="w-10 h-10 rounded-lg border-2 border-dashed border-gray-300 cursor-pointer hover:border-blue-400 transition"
                        style={{ backgroundColor: fillColor }}
                        title="点击选择颜色"
                      />
                    </div>
                    <input
                      type="text" 
                      value={fillColor}
                      onChange={(e) => setFillColor(e.target.value)}
                      className="flex-1 min-w-0 px-2 py-1.5 border rounded-lg text-sm font-mono"
                    />
                  </div>
                  <div className="flex gap-1 flex-wrap">
                    {["#ffffff", "#f5f5f5", "#e8e8e8", "#f0f0f0", "#000000"].map(c => (
                      <button
                        key={c}
                        onClick={() => setFillColor(c)}
                        className={`w-6 h-6 rounded border-2 transition ${
                          fillColor.toLowerCase() === c ? "border-blue-500" : "border-gray-200"
                        }`}
                        style={{ backgroundColor: c }}
                      />
                    ))}
                  </div>
                  <div className="text-xs text-gray-400 mt-1">
                    右键图片可取色
                  </div>
                </div>
              )}

              <div className="text-xs text-gray-400 bg-gray-50 rounded-lg p-2">
                选区: {rect.w} × {rect.h}
              </div>

              {result && (
                <div className={`p-3 rounded-lg text-sm ${
                  result.success ? "bg-green-50 text-green-600" : "bg-red-50 text-red-600"
                }`}>
                  {result.success ? "✓ 已保存" : result.message}
                </div>
              )}

              <div className="space-y-2 pt-2">
                <button 
                  onClick={handleRemove} 
                  disabled={processing} 
                  className="btn btn-primary w-full"
                >
                  {processing ? "处理中..." : "去除水印"}
                </button>
                <button 
                  onClick={() => { setImage(null); setResult(null); }} 
                  className="btn btn-default w-full"
                >
                  重新选择
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
