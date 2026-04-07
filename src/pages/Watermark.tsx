import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useTaskReporter } from "../components/TaskCenter";
import { useToast } from "../components/Toast";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { useWindowDrop } from "../hooks/useWindowDrop";
import { cn } from "../utils/cn";
import { getBaseName, getExtension } from "../utils/path";

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
  const [loading, setLoading] = useState(false);
  const [removeMode, setRemoveMode] = useState<RemoveMode>("blur");
  const [dragMode, setDragMode] = useState<DragMode>("none");
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [rectStart, setRectStart] = useState({ x: 0, y: 0, w: 0, h: 0 });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [scale, setScale] = useState(1);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const toast = useToast();
  const task = useTaskReporter("watermark");
  const { dragging } = useWindowDrop({
    active,
    onDrop: async (paths) => {
      await loadImage(paths[0]);
    },
  });

  async function loadImage(path: string) {
    const ext = getExtension(path).toLowerCase();
    if (!["png", "jpg", "jpeg", "webp"].includes(ext)) {
      toast.warning("当前仅支持 PNG、JPG、JPEG、WEBP");
      return;
    }

    setLoading(true);
    try {
      const info = await invoke<ImageInfo>("get_image_info", { path });
      setImage(info);
      setRect({ x: info.width - 120, y: info.height - 40, w: 100, h: 30 });
    } catch (e) {
      console.error("加载图片失败:", e);
      toast.error("加载图片失败: " + e);
    } finally {
      setLoading(false);
    }
  }

  async function handleSelectFile() {
    const selected = await open({
      multiple: false,
      filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp"] }],
    });
    if (selected && typeof selected === "string") {
      await loadImage(selected);
    }
  }

  useEffect(() => {
    if (!image || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      const maxW = 640;
      const maxH = 460;
      let width = image.width;
      let height = image.height;
      const ratio = Math.min(maxW / width, maxH / height, 1);
      width *= ratio;
      height *= ratio;
      setScale(ratio);
      canvas.width = width;
      canvas.height = height;
      ctx.drawImage(img, 0, 0, width, height);
    };
    img.src = image.thumbnail;
  }, [image]);

  useEffect(() => {
    if (!image || !canvasRef.current || !imgRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(imgRef.current, 0, 0, canvas.width, canvas.height);

    const x = rect.x * scale;
    const y = rect.y * scale;
    const w = rect.w * scale;
    const h = rect.h * scale;

    if (removeMode === "fill") {
      ctx.fillStyle = `${fillColor}aa`;
      ctx.fillRect(x, y, w, h);
    } else {
      ctx.fillStyle = "rgba(100, 116, 139, 0.32)";
      ctx.fillRect(x, y, w, h);
    }

    ctx.strokeStyle = "#2b68f1";
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);

    const handleSize = 8;
    ctx.fillStyle = "#2b68f1";
    const points = [
      [x, y],
      [x + w, y],
      [x, y + h],
      [x + w, y + h],
      [x + w / 2, y],
      [x + w / 2, y + h],
      [x, y + h / 2],
      [x + w, y + h / 2],
    ];
    points.forEach(([px, py]) => {
      ctx.fillRect(px - handleSize / 2, py - handleSize / 2, handleSize, handleSize);
    });
  }, [image, rect, scale, fillColor, removeMode]);

  function getHitArea(mx: number, my: number): DragMode {
    const x = rect.x * scale;
    const y = rect.y * scale;
    const w = rect.w * scale;
    const h = rect.h * scale;
    const margin = 10;

    if (Math.abs(mx - x) < margin && Math.abs(my - y) < margin) return "nw";
    if (Math.abs(mx - (x + w)) < margin && Math.abs(my - y) < margin) return "ne";
    if (Math.abs(mx - x) < margin && Math.abs(my - (y + h)) < margin) return "sw";
    if (Math.abs(mx - (x + w)) < margin && Math.abs(my - (y + h)) < margin) return "se";
    if (Math.abs(my - y) < margin && mx > x && mx < x + w) return "n";
    if (Math.abs(my - (y + h)) < margin && mx > x && mx < x + w) return "s";
    if (Math.abs(mx - x) < margin && my > y && my < y + h) return "w";
    if (Math.abs(mx - (x + w)) < margin && my > y && my < y + h) return "e";
    if (mx > x && mx < x + w && my > y && my < y + h) return "move";
    return "create";
  }

  function getCursor(mode: DragMode) {
    const map: Record<DragMode, string> = {
      none: "default",
      move: "move",
      create: "crosshair",
      nw: "nw-resize",
      ne: "ne-resize",
      sw: "sw-resize",
      se: "se-resize",
      n: "ns-resize",
      s: "ns-resize",
      e: "ew-resize",
      w: "ew-resize",
    };
    return map[mode];
  }

  function handleMouseDown(event: React.MouseEvent) {
    if (!canvasRef.current) return;
    const rectInfo = canvasRef.current.getBoundingClientRect();
    const mx = event.clientX - rectInfo.left;
    const my = event.clientY - rectInfo.top;

    if (removeMode === "fill" && event.button === 2) {
      const ctx = canvasRef.current.getContext("2d");
      if (ctx) {
        const pixel = ctx.getImageData(Math.round(mx), Math.round(my), 1, 1).data;
        setFillColor(`#${[pixel[0], pixel[1], pixel[2]].map((value) => value.toString(16).padStart(2, "0")).join("")}`);
      }
      return;
    }

    const mode = getHitArea(mx, my);
    setDragMode(mode);
    setDragStart({ x: mx, y: my });
    setRectStart({ ...rect });
  }

  function handleMouseMove(event: React.MouseEvent) {
    if (!canvasRef.current || !image) return;
    const rectInfo = canvasRef.current.getBoundingClientRect();
    const mx = event.clientX - rectInfo.left;
    const my = event.clientY - rectInfo.top;

    if (dragMode === "none") {
      canvasRef.current.style.cursor = getCursor(getHitArea(mx, my));
      return;
    }

    const dx = (mx - dragStart.x) / scale;
    const dy = (my - dragStart.y) / scale;
    let nextRect = { ...rectStart };

    switch (dragMode) {
      case "move":
        nextRect.x = Math.max(0, Math.min(image.width - nextRect.w, rectStart.x + dx));
        nextRect.y = Math.max(0, Math.min(image.height - nextRect.h, rectStart.y + dy));
        break;
      case "create":
        nextRect = {
          x: Math.min(dragStart.x / scale, mx / scale),
          y: Math.min(dragStart.y / scale, my / scale),
          w: Math.abs(dx),
          h: Math.abs(dy),
        };
        break;
      case "se":
        nextRect.w = Math.max(20, rectStart.w + dx);
        nextRect.h = Math.max(20, rectStart.h + dy);
        break;
      case "sw":
        nextRect.x = rectStart.x + dx;
        nextRect.w = Math.max(20, rectStart.w - dx);
        nextRect.h = Math.max(20, rectStart.h + dy);
        break;
      case "ne":
        nextRect.w = Math.max(20, rectStart.w + dx);
        nextRect.y = rectStart.y + dy;
        nextRect.h = Math.max(20, rectStart.h - dy);
        break;
      case "nw":
        nextRect.x = rectStart.x + dx;
        nextRect.y = rectStart.y + dy;
        nextRect.w = Math.max(20, rectStart.w - dx);
        nextRect.h = Math.max(20, rectStart.h - dy);
        break;
      case "n":
        nextRect.y = rectStart.y + dy;
        nextRect.h = Math.max(20, rectStart.h - dy);
        break;
      case "s":
        nextRect.h = Math.max(20, rectStart.h + dy);
        break;
      case "w":
        nextRect.x = rectStart.x + dx;
        nextRect.w = Math.max(20, rectStart.w - dx);
        break;
      case "e":
        nextRect.w = Math.max(20, rectStart.w + dx);
        break;
    }

    setRect({
      x: Math.round(Math.max(0, nextRect.x)),
      y: Math.round(Math.max(0, nextRect.y)),
      w: Math.round(Math.max(20, nextRect.w)),
      h: Math.round(Math.max(20, nextRect.h)),
    });
  }

  function handleMouseUp() {
    setDragMode("none");
  }

  async function handleRemove() {
    if (!image) return;
    setProcessing(true);
    try {
      await invoke<Result>("remove_watermark", {
        inputPath: image.path,
        x: rect.x,
        y: rect.y,
        width: rect.w,
        height: rect.h,
        color: fillColor,
        mode: removeMode,
        brushStrokes: [],
        brushSize: 0,
      });
      toast.success("处理完成");
    } catch (e) {
      toast.error("处理失败: " + e);
    } finally {
      setProcessing(false);
    }
  }

  function handleContextMenu(event: React.MouseEvent) {
    event.preventDefault();
    handleMouseDown(event);
  }

  useEffect(() => {
    if (!processing) {
      task.clearTask();
      return;
    }

    task.reportTask({
      title: "水印处理",
      stage: "正在应用处理",
      detail: image ? getBaseName(image.path) : "等待图片",
    });
  }, [processing, image]);

  return (
    <div className="space-y-6 p-6">
      <Card className="overflow-hidden">
        <CardContent className="px-5 py-5">
          <div
            onClick={handleSelectFile}
            className={cn("drop-zone flex flex-col items-center justify-center", dragging && "dragging")}
          >
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-[22px] bg-white text-3xl shadow-[0_16px_34px_rgba(15,23,42,0.08)]">
              {loading ? "⏳" : dragging ? "📂" : "🪄"}
            </div>
            <div className="text-lg font-semibold text-slate-900">
              {loading ? "正在载入图片" : dragging ? "松开以载入图片" : "拖入图片，或点击选择"}
            </div>
          </div>
        </CardContent>
      </Card>

      {!image ? null : (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.6fr)_360px]">
          <Card className="overflow-hidden">
            <CardHeader>
              <div>
                <CardTitle>预览画布</CardTitle>
                <div className="mt-1 text-sm text-slate-500">{getBaseName(image.path)} · {image.width} × {image.height}</div>
              </div>
              <Badge tone="info">{removeMode === "blur" ? "模糊预览" : "颜色覆盖"}</Badge>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="rounded-[24px] border border-slate-200 bg-slate-100 p-4">
                <div className="flex items-center justify-center overflow-auto rounded-[20px] bg-white p-3">
                  <canvas
                    ref={canvasRef}
                    onMouseDown={handleMouseDown}
                    onMouseMove={handleMouseMove}
                    onMouseUp={handleMouseUp}
                    onMouseLeave={handleMouseUp}
                    onContextMenu={handleContextMenu}
                    className="max-w-full"
                  />
                </div>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-500">
                拖动框选区域，拖动边角调整大小。颜色覆盖模式下可右键取色。
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div>
                <CardTitle>处理参数</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="grid gap-2">
                <button
                  onClick={() => setRemoveMode("blur")}
                  className={cn(
                    "rounded-2xl border px-4 py-3 text-left transition",
                    removeMode === "blur" ? "border-[var(--brand-300)] bg-[var(--brand-50)]" : "border-slate-200 bg-white hover:border-slate-300"
                  )}
                >
                  <div className="text-sm font-medium text-slate-900">高斯模糊</div>
                  <div className="mt-1 text-xs text-slate-500">适合不要求完全修复的局部遮挡。</div>
                </button>
                <button
                  onClick={() => setRemoveMode("fill")}
                  className={cn(
                    "rounded-2xl border px-4 py-3 text-left transition",
                    removeMode === "fill" ? "border-[var(--brand-300)] bg-[var(--brand-50)]" : "border-slate-200 bg-white hover:border-slate-300"
                  )}
                >
                  <div className="text-sm font-medium text-slate-900">颜色覆盖</div>
                  <div className="mt-1 text-xs text-slate-500">适合纯色背景、浅色边框等简单场景。</div>
                </button>
              </div>

              {removeMode === "fill" && (
                <div className="space-y-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
                  <div className="text-sm font-medium text-slate-800">覆盖颜色</div>
                  <div className="flex items-center gap-3">
                    <label
                      className="relative block h-11 w-11 overflow-hidden rounded-2xl border border-slate-200 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.8)]"
                      style={{ backgroundColor: fillColor }}
                    >
                      <input
                        type="color"
                        value={fillColor}
                        onChange={(event) => setFillColor(event.target.value)}
                        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                      />
                    </label>
                    <Input value={fillColor} onChange={(event) => setFillColor(event.target.value)} className="font-mono" />
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {["#ffffff", "#f5f5f5", "#e8e8e8", "#f0f0f0", "#000000"].map((color) => (
                      <button
                        key={color}
                        onClick={() => setFillColor(color)}
                        className={cn(
                          "h-7 w-7 rounded-full border-2 transition",
                          fillColor.toLowerCase() === color ? "border-[var(--brand-500)]" : "border-white"
                        )}
                        style={{ backgroundColor: color }}
                      />
                    ))}
                  </div>
                </div>
              )}

              <div className="grid gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-slate-500">选区尺寸</span>
                  <Badge tone="default">
                    {rect.w} × {rect.h}
                  </Badge>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-slate-500">选区位置</span>
                  <span className="font-mono text-slate-700">
                    {rect.x}, {rect.y}
                  </span>
                </div>
              </div>

              <div className="space-y-3 border-t border-slate-100 pt-4">
                <Button variant="primary" className="w-full" onClick={handleRemove} disabled={processing}>
                  {processing ? "处理中…" : "应用处理"}
                </Button>
                <Button
                  variant="secondary"
                  className="w-full"
                  onClick={() => {
                    setImage(null);
                  }}
                >
                  重新选择
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
