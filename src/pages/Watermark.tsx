import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  batchRemoveWatermark,
  cancelWatermarkTask,
  getImageInfo,
  removeWatermark,
  type BrushStroke,
  type ImageInfo,
  type WatermarkBatchProgress,
  type WatermarkResult as Result,
} from "../api/tauri";
import { useTaskReporter } from "../components/TaskCenter";
import { useToast } from "../components/Toast";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Icon } from "../components/ui/icon";
import { Input } from "../components/ui/input";
import { Slider } from "../components/ui/slider";
import { Switch } from "../components/ui/switch";
import { useFileActions } from "../hooks/useFileActions";
import { useWindowDrop } from "../hooks/useWindowDrop";
import { cn } from "../utils/cn";
import { createTaskId } from "../utils/id";
import { getBaseName, getExtension } from "../utils/path";
import { safeListen } from "../utils/tauriEvent";

interface RectSelection {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface CanvasPoint {
  mx: number;
  my: number;
  ox: number;
  oy: number;
}

interface ComparePoint {
  x: number;
  y: number;
  ox: number;
  oy: number;
}

interface Props {
  active: boolean;
}

interface LoadImageOptions {
  preserveEditContext?: boolean;
}

interface SmartTip {
  tone: "info" | "warning" | "success";
  title: string;
  description: string;
  primaryAction?: {
    label: string;
    onClick: () => void;
  };
  secondaryAction?: {
    label: string;
    onClick: () => void;
  };
}

type DragMode = "none" | "move" | "create" | "nw" | "ne" | "sw" | "se" | "n" | "s" | "e" | "w";
type RemoveMode = "blur" | "fill" | "repair";
type RepairTool = "rect" | "brush" | "erase";
type RepairMaskBase = "rect" | "blank";
type EditorMode = "simple" | "advanced";

const MIN_RECT_SIZE = 8;
const MIN_BRUSH_SIZE = 8;
const MAX_BRUSH_SIZE = 120;
const MAGNIFIER_SIZE = 176;
const MAGNIFIER_SAMPLE_SIZE = 40;
const COMPARE_MAGNIFIER_SIZE = 168;
const COMPARE_MAGNIFIER_SAMPLE_SIZE = 36;
const SIMPLE_REPAIR_MAX_AREA_RATIO = 0.08;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function clampRectToImage(nextRect: RectSelection, image: ImageInfo) {
  const minWidth = Math.min(MIN_RECT_SIZE, image.width);
  const minHeight = Math.min(MIN_RECT_SIZE, image.height);
  const width = clamp(Math.round(nextRect.w), minWidth, image.width);
  const height = clamp(Math.round(nextRect.h), minHeight, image.height);
  const x = clamp(Math.round(nextRect.x), 0, Math.max(0, image.width - width));
  const y = clamp(Math.round(nextRect.y), 0, Math.max(0, image.height - height));

  return { x, y, w: width, h: height };
}

function getCornerWatermarkRect(image: ImageInfo) {
  const width = Math.min(Math.max(Math.round(image.width * 0.22), 180), image.width);
  const height = Math.min(Math.max(Math.round(image.height * 0.055), 56), image.height);
  const rightInset = Math.round(image.width * 0.025);
  const bottomInset = Math.round(image.height * 0.035);

  return clampRectToImage(
    {
      x: image.width - width - rightInset,
      y: image.height - height - bottomInset,
      w: width,
      h: height,
    },
    image
  );
}

function getDefaultRect(image: ImageInfo) {
  return getCornerWatermarkRect(image);
}

function splitBrushGestures(strokes: BrushStroke[]) {
  const gestures: BrushStroke[][] = [];
  let currentGesture: BrushStroke[] = [];

  strokes.forEach((stroke) => {
    if (stroke.start || currentGesture.length === 0) {
      if (currentGesture.length > 0) {
        gestures.push(currentGesture);
      }
      currentGesture = [stroke];
      return;
    }

    currentGesture.push(stroke);
  });

  if (currentGesture.length > 0) {
    gestures.push(currentGesture);
  }

  return gestures;
}

function flattenBrushGestures(gestures: BrushStroke[][]) {
  return gestures.reduce<BrushStroke[]>((all, gesture) => all.concat(gesture), []);
}

function getPreviewImageSrc(image: ImageInfo) {
  return image.thumbnail || convertFileSrc(image.path);
}

function getBrushDiameter(stroke: BrushStroke, fallbackSize: number) {
  return Math.max(1, stroke.size || fallbackSize);
}

function getBatchProgressText(progress: WatermarkBatchProgress | null, fallbackDetail: string) {
  if (!progress) return fallbackDetail;
  const segments = [`已完成 ${progress.current} / ${progress.total || 0}`, `${progress.succeeded} 成功`];
  if (progress.failed > 0) segments.push(`${progress.failed} 失败`);
  if (progress.current_file) segments.push(progress.current_file);
  return segments.join(" · ");
}

function paintBrushMaskCircle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  diameter: number,
  erase: boolean,
  scale: number
) {
  ctx.save();
  ctx.globalCompositeOperation = erase ? "destination-out" : "source-over";
  ctx.fillStyle = "rgba(43, 104, 241, 0.9)";
  ctx.beginPath();
  ctx.arc(x * scale, y * scale, (diameter * scale) / 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawBrushMaskPreview(
  ctx: CanvasRenderingContext2D,
  strokes: BrushStroke[],
  scale: number,
  fallbackSize: number
) {
  let previousStroke: BrushStroke | null = null;

  strokes.forEach((stroke) => {
    const shouldConnect = previousStroke && !stroke.start && previousStroke.erase === stroke.erase;

    if (previousStroke && shouldConnect) {
      const diameter = Math.max(getBrushDiameter(previousStroke, fallbackSize), getBrushDiameter(stroke, fallbackSize));
      const dx = stroke.x - previousStroke.x;
      const dy = stroke.y - previousStroke.y;
      const distance = Math.hypot(dx, dy);

      if (distance <= Number.EPSILON) {
        paintBrushMaskCircle(ctx, stroke.x, stroke.y, diameter, stroke.erase, scale);
      } else {
        const step = Math.max(diameter / 4, 1);
        const steps = Math.max(1, Math.ceil(distance / step));

        for (let index = 0; index <= steps; index += 1) {
          const progress = index / steps;
          paintBrushMaskCircle(
            ctx,
            previousStroke.x + dx * progress,
            previousStroke.y + dy * progress,
            diameter,
            stroke.erase,
            scale
          );
        }
      }
    } else {
      paintBrushMaskCircle(ctx, stroke.x, stroke.y, getBrushDiameter(stroke, fallbackSize), stroke.erase, scale);
    }

    previousStroke = stroke;
  });
}

export default function Watermark({ active }: Props) {
  const [image, setImage] = useState<ImageInfo | null>(null);
  const [rect, setRect] = useState<RectSelection>({ x: 0, y: 0, w: 100, h: 30 });
  const [fillColor, setFillColor] = useState("#ffffff");
  const [fillOpacity, setFillOpacity] = useState(100);
  const [blurStrength, setBlurStrength] = useState(15);
  const [processing, setProcessing] = useState(false);
  const [processingMode, setProcessingMode] = useState<"single" | "batch" | null>(null);
  const [processingDetail, setProcessingDetail] = useState("");
  const [batchProgress, setBatchProgress] = useState<WatermarkBatchProgress | null>(null);
  const [loading, setLoading] = useState(false);
  const [editorMode, setEditorMode] = useState<EditorMode>("simple");
  const [removeMode, setRemoveMode] = useState<RemoveMode>("repair");
  const [dragMode, setDragMode] = useState<DragMode>("none");
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [rectStart, setRectStart] = useState<RectSelection>({ x: 0, y: 0, w: 0, h: 0 });
  const [scale, setScale] = useState(1);
  const [repairTool, setRepairTool] = useState<RepairTool>("rect");
  const [repairMaskBase, setRepairMaskBase] = useState<RepairMaskBase>("rect");
  const [brushSize, setBrushSize] = useState(30);
  const [brushStrokes, setBrushStrokes] = useState<BrushStroke[]>([]);
  const [redoBrushGestures, setRedoBrushGestures] = useState<BrushStroke[][]>([]);
  const [painting, setPainting] = useState(false);
  const [hoverPoint, setHoverPoint] = useState<CanvasPoint | null>(null);
  const [compareHoverPoint, setCompareHoverPoint] = useState<ComparePoint | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [batchResults, setBatchResults] = useState<Result[]>([]);
  const [resultPreview, setResultPreview] = useState<ImageInfo | null>(null);
  const [loadingResultPreview, setLoadingResultPreview] = useState(false);
  const [compareSplit, setCompareSplit] = useState(50);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const magnifierCanvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const originalCompareImgRef = useRef<HTMLImageElement | null>(null);
  const compareOriginalMagnifierRef = useRef<HTMLCanvasElement>(null);
  const compareResultMagnifierRef = useRef<HTMLCanvasElement>(null);
  const resultImgRef = useRef<HTMLImageElement | null>(null);
  const currentTaskIdRef = useRef<string | null>(null);
  const [originalCompareReady, setOriginalCompareReady] = useState(false);
  const [resultCompareReady, setResultCompareReady] = useState(false);
  const toast = useToast();
  const task = useTaskReporter("watermark");
  const fileActions = useFileActions();
  const simpleMode = editorMode === "simple";
  const activeRepairTool: RepairTool = simpleMode ? "rect" : repairTool;
  const activeRepairMaskBase: RepairMaskBase = simpleMode ? "rect" : repairMaskBase;
  const activeBrushStrokes = simpleMode ? [] : brushStrokes;
  const rawBrushGestureCount = splitBrushGestures(brushStrokes).length;
  const hasMaskEdits = !simpleMode && brushStrokes.length > 0;
  const brushGestureCount = simpleMode ? 0 : rawBrushGestureCount;
  const canRedoBrushStroke = !simpleMode && redoBrushGestures.length > 0;
  const { dragging } = useWindowDrop({
    active,
    onDrop: async (paths) => {
      await loadImage(paths[0]);
    },
  });

  useEffect(() => {
    if (!active) return;

    return safeListen("watermark-progress", (event) => {
      if (event.payload.task_id !== currentTaskIdRef.current) return;
      setBatchProgress((prev) => {
        if (prev && prev.task_id === event.payload.task_id && event.payload.percent < prev.percent) {
          return prev;
        }
        return event.payload;
      });
    });
  }, [active]);

  async function loadImage(path: string, options?: LoadImageOptions) {
    const ext = getExtension(path).toLowerCase();
    if (!["png", "jpg", "jpeg", "webp"].includes(ext)) {
      toast.warning("当前仅支持 PNG、JPG、JPEG、WEBP");
      return;
    }

    setLoading(true);
    try {
      const info = await getImageInfo(path);
      const preserveEditContext = options?.preserveEditContext && image;
      setImage(info);
      setRect(preserveEditContext ? clampRectToImage(rect, info) : getDefaultRect(info));
      setBrushStrokes([]);
      setRedoBrushGestures([]);
      setRepairTool(preserveEditContext && removeMode === "repair" && !simpleMode ? "brush" : "rect");
      if (!preserveEditContext) {
        setRepairMaskBase("rect");
      }
      setHoverPoint(null);
      setCompareHoverPoint(null);
      setOriginalCompareReady(false);
      setResultCompareReady(false);
      setResult(null);
      setBatchResults([]);
      setResultPreview(null);
      setLoadingResultPreview(false);
      setCompareSplit(50);
      if (preserveEditContext) {
        toast.info("已载入结果图，保留当前模式和选区，可继续精修");
      }
    } catch (error) {
      console.error("加载图片失败:", error);
      toast.error("加载图片失败: " + error);
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

  async function handleContinueRefine() {
    if (!result?.output_path) return;
    await loadImage(result.output_path, { preserveEditContext: true });
  }

  function switchToPreciseRepair() {
    setEditorMode("advanced");
    setRepairMaskBase("blank");
    setRepairTool("brush");
    setBrushStrokes([]);
    setRedoBrushGestures([]);
  }

  function applyCornerWatermarkPreset() {
    if (!image) return;

    setRect(getCornerWatermarkRect(image));
    setRemoveMode("repair");
    setEditorMode("simple");
    setRepairMaskBase("rect");
    setRepairTool("rect");
    setBrushStrokes([]);
    setRedoBrushGestures([]);
    setHoverPoint(null);
    toast.info("已套用右下角小水印选区");
  }

  function drawRepairMask(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement) {
    const x = rect.x * scale;
    const y = rect.y * scale;
    const w = rect.w * scale;
    const h = rect.h * scale;
    const overlayCanvas = document.createElement("canvas");
    overlayCanvas.width = canvas.width;
    overlayCanvas.height = canvas.height;
    const overlayCtx = overlayCanvas.getContext("2d");
    if (!overlayCtx) return;

    if (activeRepairMaskBase === "rect") {
      overlayCtx.fillStyle = "rgba(43, 104, 241, 0.22)";
      overlayCtx.fillRect(x, y, w, h);
    }

    drawBrushMaskPreview(overlayCtx, activeBrushStrokes, scale, brushSize);

    ctx.drawImage(overlayCanvas, 0, 0);
  }

  useEffect(() => {
    if (!image || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const img = new Image();
    const sources = [getPreviewImageSrc(image), convertFileSrc(image.path)].filter((src, index, all) => src && all.indexOf(src) === index);
    let sourceIndex = 0;

    img.onload = () => {
      imgRef.current = img;
      const ratio = Math.min(640 / image.width, 460 / image.height, 1);
      const width = image.width * ratio;
      const height = image.height * ratio;

      setScale(ratio);
      canvas.width = width;
      canvas.height = height;
      ctx.drawImage(img, 0, 0, width, height);
    };
    img.onerror = () => {
      sourceIndex += 1;
      if (sourceIndex < sources.length) {
        img.src = sources[sourceIndex];
      }
    };
    img.src = sources[0];
  }, [image]);

  useEffect(() => {
    if (!image) {
      originalCompareImgRef.current = null;
      setOriginalCompareReady(false);
      return;
    }

    setOriginalCompareReady(false);
    const img = new Image();
    img.onload = () => {
      originalCompareImgRef.current = img;
      setOriginalCompareReady(true);
    };
    img.src = convertFileSrc(image.path);
  }, [image]);

  useEffect(() => {
    if (!resultPreview) {
      resultImgRef.current = null;
      setResultCompareReady(false);
      return;
    }

    setResultCompareReady(false);
    const img = new Image();
    img.onload = () => {
      resultImgRef.current = img;
      setResultCompareReady(true);
    };
    img.src = convertFileSrc(resultPreview.path);
  }, [resultPreview]);

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
      ctx.save();
      ctx.globalAlpha = fillOpacity / 100;
      ctx.fillStyle = fillColor;
      ctx.fillRect(x, y, w, h);
      ctx.restore();
    } else if (removeMode === "blur") {
      const overlayAlpha = clamp(0.18 + blurStrength / 80, 0.22, 0.58);
      ctx.fillStyle = `rgba(100, 116, 139, ${overlayAlpha})`;
      ctx.fillRect(x, y, w, h);
    } else {
      drawRepairMask(ctx, canvas);
    }

    ctx.strokeStyle = removeMode === "repair" ? "#1d4ed8" : "#2b68f1";
    ctx.lineWidth = 2;
    ctx.setLineDash(removeMode === "repair" ? [8, 5] : [6, 4]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);

    if (removeMode === "repair" && activeRepairTool !== "rect") {
      return;
    }

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
  }, [activeBrushStrokes, activeRepairMaskBase, activeRepairTool, blurStrength, brushSize, fillColor, fillOpacity, image, rect, removeMode, scale]);

  useEffect(() => {
    if (!canvasRef.current) return;
    canvasRef.current.style.cursor = removeMode === "repair" && activeRepairTool !== "rect" ? "crosshair" : "default";
  }, [activeRepairTool, removeMode]);

  useEffect(() => {
    if (!hoverPoint || !canvasRef.current || !magnifierCanvasRef.current) return;

    const sourceCanvas = canvasRef.current;
    const targetCanvas = magnifierCanvasRef.current;
    const ctx = targetCanvas.getContext("2d");
    if (!ctx) return;

    const sampleSize = Math.min(
      MAGNIFIER_SAMPLE_SIZE,
      Math.max(12, Math.min(sourceCanvas.width, sourceCanvas.height))
    );
    const sx = clamp(hoverPoint.mx - sampleSize / 2, 0, Math.max(0, sourceCanvas.width - sampleSize));
    const sy = clamp(hoverPoint.my - sampleSize / 2, 0, Math.max(0, sourceCanvas.height - sampleSize));

    targetCanvas.width = MAGNIFIER_SIZE;
    targetCanvas.height = MAGNIFIER_SIZE;
    ctx.clearRect(0, 0, MAGNIFIER_SIZE, MAGNIFIER_SIZE);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(sourceCanvas, sx, sy, sampleSize, sampleSize, 0, 0, MAGNIFIER_SIZE, MAGNIFIER_SIZE);

    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.95)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(MAGNIFIER_SIZE / 2, 0);
    ctx.lineTo(MAGNIFIER_SIZE / 2, MAGNIFIER_SIZE);
    ctx.moveTo(0, MAGNIFIER_SIZE / 2);
    ctx.lineTo(MAGNIFIER_SIZE, MAGNIFIER_SIZE / 2);
    ctx.stroke();

    ctx.strokeStyle = "rgba(15,23,42,0.28)";
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, MAGNIFIER_SIZE - 1, MAGNIFIER_SIZE - 1);
    ctx.restore();
  }, [activeBrushStrokes, activeRepairMaskBase, activeRepairTool, blurStrength, brushSize, fillColor, fillOpacity, hoverPoint, rect, removeMode, scale]);

  function drawImageMagnifier(
    sourceImage: HTMLImageElement,
    targetCanvas: HTMLCanvasElement,
    sourceWidth: number,
    sourceHeight: number,
    ox: number,
    oy: number,
    targetSize: number,
    sampleSize: number
  ) {
    const ctx = targetCanvas.getContext("2d");
    if (!ctx) return;

    const drawWidth = sourceImage.naturalWidth || sourceImage.width;
    const drawHeight = sourceImage.naturalHeight || sourceImage.height;
    if (!drawWidth || !drawHeight || sourceWidth <= 0 || sourceHeight <= 0) return;

    const px = (ox / sourceWidth) * drawWidth;
    const py = (oy / sourceHeight) * drawHeight;
    const actualSampleSize = Math.min(sampleSize, Math.max(12, Math.min(drawWidth, drawHeight)));
    const sx = clamp(px - actualSampleSize / 2, 0, Math.max(0, drawWidth - actualSampleSize));
    const sy = clamp(py - actualSampleSize / 2, 0, Math.max(0, drawHeight - actualSampleSize));

    targetCanvas.width = targetSize;
    targetCanvas.height = targetSize;
    ctx.clearRect(0, 0, targetSize, targetSize);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(sourceImage, sx, sy, actualSampleSize, actualSampleSize, 0, 0, targetSize, targetSize);

    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.95)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(targetSize / 2, 0);
    ctx.lineTo(targetSize / 2, targetSize);
    ctx.moveTo(0, targetSize / 2);
    ctx.lineTo(targetSize, targetSize / 2);
    ctx.stroke();

    ctx.strokeStyle = "rgba(15,23,42,0.28)";
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, targetSize - 1, targetSize - 1);
    ctx.restore();
  }

  useEffect(() => {
    if (
      !compareHoverPoint ||
      !image ||
      !resultPreview ||
      !originalCompareReady ||
      !resultCompareReady ||
      !originalCompareImgRef.current ||
      !resultImgRef.current ||
      !compareOriginalMagnifierRef.current ||
      !compareResultMagnifierRef.current
    ) {
      return;
    }

    drawImageMagnifier(
      originalCompareImgRef.current,
      compareOriginalMagnifierRef.current,
      image.width,
      image.height,
      compareHoverPoint.ox,
      compareHoverPoint.oy,
      COMPARE_MAGNIFIER_SIZE,
      COMPARE_MAGNIFIER_SAMPLE_SIZE
    );
    drawImageMagnifier(
      resultImgRef.current,
      compareResultMagnifierRef.current,
      image.width,
      image.height,
      compareHoverPoint.ox,
      compareHoverPoint.oy,
      COMPARE_MAGNIFIER_SIZE,
      COMPARE_MAGNIFIER_SAMPLE_SIZE
    );
  }, [compareHoverPoint, image, originalCompareReady, resultCompareReady, resultPreview]);

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

  function getCanvasPoint(event: React.MouseEvent) {
    if (!canvasRef.current || !image) return null;

    const rectInfo = canvasRef.current.getBoundingClientRect();
    const mx = clamp(event.clientX - rectInfo.left, 0, rectInfo.width);
    const my = clamp(event.clientY - rectInfo.top, 0, rectInfo.height);

    return {
      mx,
      my,
      ox: clamp(mx / scale, 0, image.width),
      oy: clamp(my / scale, 0, image.height),
    };
  }

  function handleCompareMouseMove(event: React.MouseEvent<HTMLDivElement>) {
    if (!image) return;

    const bounds = event.currentTarget.getBoundingClientRect();
    const x = clamp(event.clientX - bounds.left, 0, bounds.width);
    const y = clamp(event.clientY - bounds.top, 0, bounds.height);

    setCompareHoverPoint({
      x,
      y,
      ox: clamp((x / bounds.width) * image.width, 0, image.width),
      oy: clamp((y / bounds.height) * image.height, 0, image.height),
    });
  }

  function handleCompareMouseLeave() {
    setCompareHoverPoint(null);
  }

  function pickColorFromOriginal(mx: number, my: number) {
    if (!canvasRef.current || !imgRef.current) return;

    const sampleCanvas = document.createElement("canvas");
    sampleCanvas.width = canvasRef.current.width;
    sampleCanvas.height = canvasRef.current.height;
    const sampleCtx = sampleCanvas.getContext("2d");
    if (!sampleCtx) return;

    sampleCtx.drawImage(imgRef.current, 0, 0, sampleCanvas.width, sampleCanvas.height);
    const pixel = sampleCtx.getImageData(Math.round(mx), Math.round(my), 1, 1).data;
    setFillColor(`#${[pixel[0], pixel[1], pixel[2]].map((value) => value.toString(16).padStart(2, "0")).join("")}`);
  }

  function addBrushStroke(ox: number, oy: number, erase: boolean, start: boolean) {
    if (start && redoBrushGestures.length > 0) {
      setRedoBrushGestures([]);
    }

    setBrushStrokes((prev) => {
      const nextStroke = {
        x: Number(ox.toFixed(2)),
        y: Number(oy.toFixed(2)),
        size: brushSize,
        erase,
        start,
      };
      const last = prev[prev.length - 1];
      if (
        !start &&
        last &&
        last.erase === nextStroke.erase &&
        last.size === nextStroke.size &&
        Math.hypot(last.x - nextStroke.x, last.y - nextStroke.y) < Math.max(1.5, brushSize * 0.18)
      ) {
        return prev;
      }
      return [...prev, nextStroke];
    });
  }

  function handleUndoBrushStroke() {
    if (processing) return;

    const gestures = splitBrushGestures(brushStrokes);
    if (!gestures.length) return;

    const nextGestures = gestures.slice(0, -1);
    const undoneGesture = gestures[gestures.length - 1];
    setBrushStrokes(flattenBrushGestures(nextGestures));
    setRedoBrushGestures((prev) => [undoneGesture, ...prev]);
  }

  function handleRedoBrushStroke() {
    if (processing) return;
    if (!redoBrushGestures.length) return;

    const [gesture, ...remaining] = redoBrushGestures;
    setBrushStrokes((prev) => prev.concat(gesture));
    setRedoBrushGestures(remaining);
  }

  async function loadResultPreview(path: string) {
    setCompareHoverPoint(null);
    setResultPreview(null);
    setLoadingResultPreview(true);
    try {
      const info = await getImageInfo(path);
      setResultPreview(info);
    } catch (error) {
      console.error("加载结果预览失败:", error);
      setResultPreview(null);
      toast.warning("结果已生成，但前后对比预览加载失败");
    } finally {
      setLoadingResultPreview(false);
    }
  }

  function handleMouseDown(event: React.MouseEvent) {
    const point = getCanvasPoint(event);
    if (!point || !image) return;
    setHoverPoint(point);

    if (removeMode === "fill" && event.button === 2) {
      pickColorFromOriginal(point.mx, point.my);
      return;
    }

    if (removeMode === "repair" && activeRepairTool !== "rect") {
      if (event.button !== 0) return;
      setPainting(true);
      addBrushStroke(point.ox, point.oy, activeRepairTool === "erase", true);
      return;
    }

    if (event.button !== 0) return;

    const nextDragMode = getHitArea(point.mx, point.my);
    setDragMode(nextDragMode);
    setDragStart({ x: point.mx, y: point.my });
    setRectStart({ ...rect });
  }

  function handleMouseMove(event: React.MouseEvent) {
    const point = getCanvasPoint(event);
    if (!point || !canvasRef.current || !image) return;
    setHoverPoint(point);

    if (removeMode === "repair" && activeRepairTool !== "rect") {
      canvasRef.current.style.cursor = "crosshair";
      if (painting && (event.buttons & 1) === 1) {
        addBrushStroke(point.ox, point.oy, activeRepairTool === "erase", false);
      }
      return;
    }

    if (dragMode === "none") {
      canvasRef.current.style.cursor = getCursor(getHitArea(point.mx, point.my));
      return;
    }

    const dx = (point.mx - dragStart.x) / scale;
    const dy = (point.my - dragStart.y) / scale;
    let nextRect = { ...rectStart };

    switch (dragMode) {
      case "move":
        nextRect.x = rectStart.x + dx;
        nextRect.y = rectStart.y + dy;
        break;
      case "create":
        nextRect = {
          x: Math.min(dragStart.x / scale, point.mx / scale),
          y: Math.min(dragStart.y / scale, point.my / scale),
          w: Math.abs(dx),
          h: Math.abs(dy),
        };
        break;
      case "se":
        nextRect.w = rectStart.w + dx;
        nextRect.h = rectStart.h + dy;
        break;
      case "sw":
        nextRect.x = rectStart.x + dx;
        nextRect.w = rectStart.w - dx;
        nextRect.h = rectStart.h + dy;
        break;
      case "ne":
        nextRect.w = rectStart.w + dx;
        nextRect.y = rectStart.y + dy;
        nextRect.h = rectStart.h - dy;
        break;
      case "nw":
        nextRect.x = rectStart.x + dx;
        nextRect.y = rectStart.y + dy;
        nextRect.w = rectStart.w - dx;
        nextRect.h = rectStart.h - dy;
        break;
      case "n":
        nextRect.y = rectStart.y + dy;
        nextRect.h = rectStart.h - dy;
        break;
      case "s":
        nextRect.h = rectStart.h + dy;
        break;
      case "w":
        nextRect.x = rectStart.x + dx;
        nextRect.w = rectStart.w - dx;
        break;
      case "e":
        nextRect.w = rectStart.w + dx;
        break;
    }

    setRect(clampRectToImage(nextRect, image));
  }

  function handleMouseUp() {
    setDragMode("none");
    setPainting(false);
  }

  function handleMouseLeave() {
    handleMouseUp();
    setHoverPoint(null);
  }

  async function handleRemove() {
    if (!image) return;
    if (simpleRepairNeedsPrecision) {
      switchToPreciseRepair();
      toast.warning(`当前选区约占整图 ${selectionAreaPercent}%，简洁模式直接修复容易出现明显糊块，已切到高级精修`);
      return;
    }

    setProcessing(true);
    setProcessingMode("single");
    setProcessingDetail(getBaseName(image.path));
    try {
      const response = await removeWatermark({
        inputPath: image.path,
        x: rect.x,
        y: rect.y,
        width: rect.w,
        height: rect.h,
        color: fillColor,
        fillOpacity,
        blurStrength,
        mode: removeMode,
        repairBaseMode: activeRepairMaskBase,
        brushStrokes: activeBrushStrokes,
        brushSize,
      });
      setResult(response);
      setBatchResults([]);
      setCompareSplit(50);
      toast.success(response.message);
      void loadResultPreview(response.output_path);
    } catch (error) {
      toast.error("处理失败: " + error);
    } finally {
      setProcessing(false);
      setProcessingMode(null);
      setProcessingDetail("");
    }
  }

  async function handleBatchApply() {
    if (!image) return;
    if (simpleRepairNeedsPrecision) {
      switchToPreciseRepair();
      toast.warning(`当前选区约占整图 ${selectionAreaPercent}%，不建议直接批量基础修复，已切到高级精修`);
      return;
    }

    const selected = await open({
      multiple: true,
      filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp"] }],
    });

    const inputPaths =
      typeof selected === "string" ? [selected] : Array.isArray(selected) ? selected.filter((item): item is string => typeof item === "string") : [];

    if (!inputPaths.length) return;

    const taskId = createTaskId("watermark");
    currentTaskIdRef.current = taskId;
    setProcessing(true);
    setProcessingMode("batch");
    setProcessingDetail(`${inputPaths.length} 张图片`);
    setBatchProgress({
      task_id: taskId,
      stage: "准备批量处理",
      current: 0,
      total: inputPaths.length,
      percent: 0,
      current_file: "",
      succeeded: 0,
      failed: 0,
    });
    setBatchResults([]);

    try {
      const response = await batchRemoveWatermark({
        taskId,
        inputPaths,
        expectedWidth: image.width,
        expectedHeight: image.height,
        x: rect.x,
        y: rect.y,
        width: rect.w,
        height: rect.h,
        color: fillColor,
        fillOpacity,
        blurStrength,
        mode: removeMode,
        repairBaseMode: activeRepairMaskBase,
        brushStrokes: activeBrushStrokes,
        brushSize,
      });

      if (currentTaskIdRef.current !== taskId) return;
      setBatchResults(response);
      const succeeded = response.filter((item) => item.success).length;
      const failed = response.length - succeeded;
      if (failed === 0) {
        toast.success(`批量处理完成，共 ${succeeded} 张`);
      } else {
        toast.warning(`批量处理完成：成功 ${succeeded}，失败 ${failed}`);
      }
    } catch (error) {
      if (currentTaskIdRef.current !== taskId) return;
      const message = String(error);
      if (message.includes("取消")) {
        toast.info("已取消批量处理");
      } else {
        toast.error("批量处理失败: " + error);
      }
    } finally {
      if (currentTaskIdRef.current !== taskId) return;
      currentTaskIdRef.current = null;
      setProcessing(false);
      setProcessingMode(null);
      setProcessingDetail("");
      setBatchProgress(null);
    }
  }

  async function cancelBatchApply() {
    const taskId = currentTaskIdRef.current;
    if (!taskId) return;

    try {
      await cancelWatermarkTask(taskId);
      currentTaskIdRef.current = null;
      setProcessing(false);
      setProcessingMode(null);
      setProcessingDetail("");
      setBatchProgress(null);
      toast.info("已取消批量处理");
    } catch (error) {
      toast.error("取消失败: " + error);
    }
  }

  function handleContextMenu(event: React.MouseEvent) {
    event.preventDefault();
    if (removeMode === "fill") {
      handleMouseDown(event);
    }
  }

  useEffect(() => {
    if (!processing) {
      task.clearTask();
      return;
    }

    task.reportTask({
      title: "水印处理",
      stage:
        processingMode === "batch"
          ? batchProgress?.stage || "正在批量应用当前配置"
          : removeMode === "repair"
            ? "正在执行基础修复"
            : "正在应用处理",
      detail:
        processingMode === "batch"
          ? getBatchProgressText(batchProgress, processingDetail)
          : processingDetail || (image ? getBaseName(image.path) : "等待图片"),
      progress: processingMode === "batch" ? batchProgress?.percent : undefined,
      cancellable: processingMode === "batch",
      onCancel: processingMode === "batch" ? cancelBatchApply : undefined,
    });
  }, [batchProgress, image, processing, processingDetail, processingMode, removeMode]);

  useEffect(() => {
    if (processing || !active || simpleMode || removeMode !== "repair" || (!brushStrokes.length && !redoBrushGestures.length)) return;

    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target;
      const isEditable =
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);

      if (isEditable) return;

      if (event.metaKey || event.ctrlKey) {
        const key = event.key.toLowerCase();

        if (key === "z") {
          event.preventDefault();
          if (event.shiftKey) {
            handleRedoBrushStroke();
          } else {
            handleUndoBrushStroke();
          }
          return;
        }

        if (key === "y") {
          event.preventDefault();
          handleRedoBrushStroke();
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [active, brushStrokes.length, processing, redoBrushGestures, removeMode, simpleMode]);

  const canvasHint =
    removeMode === "repair"
      ? simpleMode
        ? "拖动矩形框住水印后直接执行基础修复。需要补涂、擦除或空蒙版时，再切到高级模式。"
        : activeRepairTool === "rect"
          ? activeRepairMaskBase === "rect"
            ? "拖动矩形定义基础修复区域，再切到补涂或擦除精修蒙版。"
            : "拖动矩形做定位参考；空蒙版模式下，真正的修复区域需要用笔刷补涂出来。"
          : activeRepairTool === "brush"
            ? activeRepairMaskBase === "rect"
              ? "在画布上补涂需要修复的区域；矩形选区会作为默认基础蒙版。"
              : "空蒙版模式下，从需要修复的位置开始补涂，适合不规则或分散的小水印。"
            : activeRepairMaskBase === "rect"
              ? "在画布上擦除误选区域；适合把修复范围从矩形里抠细。"
              : "在画布上擦除误涂区域；空蒙版模式下，建议先补涂再用擦除细修边缘。"
      : "拖动框选区域，拖动边角调整大小。颜色覆盖模式下可右键取色。";
  const magnifierZoom = (MAGNIFIER_SIZE / MAGNIFIER_SAMPLE_SIZE).toFixed(1);
  const imageArea = image ? image.width * image.height : 0;
  const selectionAreaRatio = imageArea > 0 ? (rect.w * rect.h) / imageArea : 0;
  const simpleRepairNeedsPrecision = removeMode === "repair" && simpleMode && selectionAreaRatio > SIMPLE_REPAIR_MAX_AREA_RATIO;
  const selectionAreaPercent = (selectionAreaRatio * 100).toFixed(1);
  const manualStrokeCount = brushGestureCount;
  const smartTips: SmartTip[] = [];

  if (removeMode === "repair") {
    if (simpleMode) {
      smartTips.push({
        tone: "info",
        title: "当前是简洁模式",
        description: "现在只用矩形快速修复，先把水印框准就能直接处理。需要补涂、擦除或空蒙版时，再打开高级模式。",
        primaryAction: {
          label: "打开高级模式",
          onClick: () => setEditorMode("advanced"),
        },
      });
    }

    if (simpleRepairNeedsPrecision) {
      smartTips.unshift({
        tone: "warning",
        title: "当前选区偏大，直接修复会更容易发糊",
        description: `现在的选区约占整图 ${selectionAreaPercent}%。简洁模式更适合小水印；这种范围建议切到高级模式，用空蒙版只补涂水印本体。`,
        primaryAction: {
          label: "切到精修",
          onClick: () => switchToPreciseRepair(),
        },
      });
    }

    if (!simpleMode && activeRepairMaskBase === "blank" && manualStrokeCount === 0) {
      smartTips.push({
        tone: "warning",
        title: "空蒙版还没有修复区域",
        description: "当前矩形只用于定位，不会参与修复。执行前先切到补涂，把真正需要处理的区域画出来。",
        primaryAction: {
          label: "切到补涂",
          onClick: () => setRepairTool("brush"),
        },
      });
    }

    if (!simpleMode && activeRepairMaskBase === "rect" && selectionAreaRatio > 0.12 && manualStrokeCount === 0) {
      smartTips.push({
        tone: "warning",
        title: "修复范围偏大",
        description: "当前矩形覆盖面积较大，整块修复容易伤到周边内容。更稳的做法是切到空蒙版，只涂水印本体。",
        primaryAction: {
          label: "改为空蒙版",
          onClick: () => {
            setRepairMaskBase("blank");
            setRepairTool("brush");
          },
        },
      });
    }

    if (!simpleMode && activeRepairTool === "rect" && manualStrokeCount > 0) {
      smartTips.push({
        tone: "info",
        title: "已经进入精修阶段",
        description: "你已经有手工蒙版了。继续微调时，直接切到补涂或擦除会比反复拖框更顺手。",
        primaryAction: {
          label: "切到补涂",
          onClick: () => setRepairTool("brush"),
        },
        secondaryAction: {
          label: "切到擦除",
          onClick: () => setRepairTool("erase"),
        },
      });
    }

    if (result?.output_path) {
      smartTips.push({
        tone: "success",
        title: "结果图可以直接继续精修",
        description: "如果边缘还有一点不自然，直接进入结果图继续补涂或擦除，比重新从原图开始更省事。",
        primaryAction: {
          label: "继续精修",
          onClick: () => {
            void handleContinueRefine();
          },
        },
      });
    }
  } else if (removeMode === "fill" && selectionAreaRatio > 0.08) {
    smartTips.push({
      tone: "warning",
      title: "填色区域偏大",
      description: "颜色覆盖更适合纯色背景和小范围遮挡。当前范围较大时，边缘会更容易显眼，建议改成基础修复。",
      primaryAction: {
        label: "切到基础修复",
        onClick: () => setRemoveMode("repair"),
      },
    });
  } else if (removeMode === "blur" && selectionAreaRatio > 0.12) {
    smartTips.push({
      tone: "warning",
      title: "模糊范围偏大",
      description: "模糊更适合快速遮挡。当前范围较大时，画面会明显发糊，建议缩小范围或换成基础修复。",
      primaryAction: {
        label: "切到基础修复",
        onClick: () => setRemoveMode("repair"),
      },
    });
  }

  return (
    <div className="space-y-6 p-6">
      <Card className="overflow-hidden">
        <CardContent className="px-5 py-5">
          <div
            onClick={handleSelectFile}
            className={cn("drop-zone flex flex-col items-center justify-center", dragging && "dragging")}
          >
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-[8px] border border-slate-200 bg-slate-50 text-[var(--brand-700)]">
              <Icon
                name={dragging ? "folderOpen" : "magic"}
                size={30}
                className={loading ? "animate-pulse" : undefined}
              />
            </div>
            <div className="text-lg font-semibold text-slate-900">
              {loading ? "正在载入图片" : dragging ? "松开以载入图片" : "拖入图片，或点击选择"}
            </div>
          </div>
        </CardContent>
      </Card>

      {!image ? null : (
        <div className="space-y-6">
          <div className="grid gap-6 xl:grid-cols-[minmax(0,1.6fr)_360px]">
            <Card className="overflow-hidden">
              <CardHeader>
                <div>
                  <CardTitle>预览画布</CardTitle>
                  <div className="mt-1 text-sm text-slate-500">
                    {getBaseName(image.path)} · {image.width} × {image.height}
                  </div>
                </div>
                <Badge tone={removeMode === "repair" ? "success" : "info"}>
                  {removeMode === "blur" ? "模糊预览" : removeMode === "fill" ? "颜色覆盖" : "纹理修补蒙版"}
                </Badge>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="rounded-[24px] border border-slate-200 bg-slate-100 p-4">
                  <div className="flex items-center justify-center overflow-auto rounded-[20px] bg-white p-3">
                    <canvas
                      ref={canvasRef}
                      onMouseDown={handleMouseDown}
                      onMouseMove={handleMouseMove}
                      onMouseUp={handleMouseUp}
                      onMouseLeave={handleMouseLeave}
                      onContextMenu={handleContextMenu}
                      className="max-w-full"
                    />
                  </div>
                </div>
                <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_220px]">
                  <div className="rounded-[10px] border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-500">
                    {canvasHint}
                  </div>
                  <div className="rounded-[10px] border border-slate-200 bg-slate-50 px-4 py-3">
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <div className="text-sm font-medium text-slate-800">局部放大镜</div>
                      <Badge tone="default">{magnifierZoom}x</Badge>
                    </div>
                    <div className="flex justify-center">
                      {hoverPoint ? (
                        <canvas
                          ref={magnifierCanvasRef}
                          className="h-44 w-44 rounded-[10px] border border-slate-200 bg-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.85)]"
                        />
                      ) : (
                        <div className="flex h-44 w-44 items-center justify-center rounded-[10px] border border-dashed border-slate-200 bg-white text-center text-xs leading-5 text-slate-400">
                          将鼠标移到画布上
                          <br />
                          查看局部细节
                        </div>
                      )}
                    </div>
                    <div className="mt-3 text-xs leading-5 text-slate-500">
                      {hoverPoint
                        ? `当前位置 ${Math.round(hoverPoint.ox)}, ${Math.round(hoverPoint.oy)}`
                        : "适合检查边缘、文字笔画和小范围误涂。"}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <CardTitle>处理参数</CardTitle>
                    <div className="mt-1 text-sm text-slate-500">{simpleMode ? "简洁模式" : "高级模式"}</div>
                  </div>
                  <label className="flex items-center gap-3 text-sm text-slate-600">
                    <span>高级模式</span>
                    <Switch checked={!simpleMode} onCheckedChange={(checked) => setEditorMode(checked ? "advanced" : "simple")} />
                  </label>
                </div>
              </CardHeader>
              <CardContent className="space-y-5">
                <div className="grid gap-2">
                  <button
                    onClick={() => setRemoveMode("repair")}
                    className={cn(
                      "rounded-[10px] border px-4 py-3 text-left transition",
                      removeMode === "repair" ? "border-[var(--brand-300)] bg-[var(--brand-50)]" : "border-slate-200 bg-white hover:border-slate-300"
                    )}
                  >
                    <div className="text-sm font-medium text-slate-900">基础修复</div>
                    <div className="mt-1 text-xs text-slate-500">优先使用周边纹理修补，尽量避免明显糊块；更适合小水印、角标和日期字样。</div>
                  </button>
                  <button
                    onClick={() => setRemoveMode("blur")}
                    className={cn(
                      "rounded-[10px] border px-4 py-3 text-left transition",
                      removeMode === "blur" ? "border-[var(--brand-300)] bg-[var(--brand-50)]" : "border-slate-200 bg-white hover:border-slate-300"
                    )}
                  >
                    <div className="text-sm font-medium text-slate-900">高斯模糊</div>
                    <div className="mt-1 text-xs text-slate-500">适合不要求完全修复的局部遮挡。</div>
                  </button>
                  <button
                    onClick={() => setRemoveMode("fill")}
                    className={cn(
                      "rounded-[10px] border px-4 py-3 text-left transition",
                      removeMode === "fill" ? "border-[var(--brand-300)] bg-[var(--brand-50)]" : "border-slate-200 bg-white hover:border-slate-300"
                    )}
                  >
                    <div className="text-sm font-medium text-slate-900">颜色覆盖</div>
                    <div className="mt-1 text-xs text-slate-500">适合纯色背景、浅色边框等简单场景。</div>
                  </button>
                </div>

                {removeMode === "repair" && (
                  <div className="space-y-4 rounded-[10px] border border-slate-200 bg-slate-50 px-4 py-4">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-sm font-medium text-slate-800">{simpleMode ? "快速修复" : "修复蒙版"}</div>
                      <Badge tone={hasMaskEdits ? "info" : "default"}>
                        {simpleMode
                          ? "仅使用矩形选区"
                          : hasMaskEdits
                          ? `已补涂 ${brushGestureCount} 笔`
                          : activeRepairMaskBase === "rect"
                            ? "仅矩形基础蒙版"
                            : "当前为空蒙版"}
                      </Badge>
                    </div>

                    {simpleMode ? (
                      <div className="space-y-3">
                        <div className="text-xs leading-5 text-slate-500">
                          简洁模式下只使用当前矩形做基础修复。把水印框准后可以直接处理；只有在边缘复杂、形状不规则时，才需要打开高级模式做补涂或擦除。
                        </div>
                        {simpleRepairNeedsPrecision && (
                          <div className="rounded-[10px] border border-amber-100 bg-amber-50/85 px-3 py-3 text-xs leading-5 text-amber-900">
                            当前选区约占整图 {selectionAreaPercent}%。这已经超出简洁模式适合的范围，直接修复更容易留下明显糊块。
                          </div>
                        )}
                        <Button variant="secondary" size="sm" onClick={() => setEditorMode("advanced")}>
                          打开高级模式
                        </Button>
                      </div>
                    ) : (
                      <>
                        <div className="grid gap-2 sm:grid-cols-2">
                          {[
                            { key: "rect", label: "矩形起步", description: "默认整块进入修复，再用笔刷细修" },
                            { key: "blank", label: "空蒙版", description: "不自动包含矩形，完全靠笔刷定义修复区" },
                          ].map((mode) => (
                            <button
                              key={mode.key}
                              onClick={() => setRepairMaskBase(mode.key as RepairMaskBase)}
                              className={cn(
                                "rounded-[10px] border px-3 py-3 text-left transition",
                                activeRepairMaskBase === mode.key ? "border-[var(--brand-300)] bg-white ring-1 ring-blue-100" : "border-slate-200 bg-white/80 hover:border-slate-300"
                              )}
                            >
                              <div className="text-sm font-medium text-slate-900">{mode.label}</div>
                              <div className="mt-1 text-xs text-slate-500">{mode.description}</div>
                            </button>
                          ))}
                        </div>

                        <div className="grid gap-2 sm:grid-cols-3">
                          {[
                            { key: "rect", label: "框选", description: "调整基础区域" },
                            { key: "brush", label: "补涂", description: "补足遗漏区域" },
                            { key: "erase", label: "擦除", description: "去掉误选区域" },
                          ].map((tool) => (
                            <button
                              key={tool.key}
                              onClick={() => setRepairTool(tool.key as RepairTool)}
                              className={cn(
                                "rounded-[10px] border px-3 py-3 text-left transition",
                                activeRepairTool === tool.key ? "border-[var(--brand-300)] bg-white ring-1 ring-blue-100" : "border-slate-200 bg-white/80 hover:border-slate-300"
                              )}
                            >
                              <div className="text-sm font-medium text-slate-900">{tool.label}</div>
                              <div className="mt-1 text-xs text-slate-500">{tool.description}</div>
                            </button>
                          ))}
                        </div>

                        <div className="space-y-2">
                          <div className="flex items-center justify-between text-sm">
                            <span className="text-slate-500">笔刷大小</span>
                            <span className="font-mono text-slate-700">{brushSize}px</span>
                          </div>
                          <Slider
                            min={MIN_BRUSH_SIZE}
                            max={MAX_BRUSH_SIZE}
                            value={brushSize}
                            onValueChange={setBrushSize}
                          />
                        </div>

                        <div className="flex flex-wrap gap-2">
                          <Button variant="secondary" size="sm" onClick={handleUndoBrushStroke} disabled={processing || !hasMaskEdits}>
                            撤销一步
                          </Button>
                          <Button variant="secondary" size="sm" onClick={handleRedoBrushStroke} disabled={processing || !canRedoBrushStroke}>
                            重做一步
                          </Button>
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => {
                              setBrushStrokes([]);
                              setRedoBrushGestures([]);
                            }}
                            disabled={processing || !hasMaskEdits}
                          >
                            清空涂抹
                          </Button>
                          <Button variant="secondary" size="sm" onClick={() => setRepairTool("rect")}>
                            回到框选
                          </Button>
                        </div>

                        <div className="text-xs leading-5 text-slate-500">
                          {activeRepairMaskBase === "rect"
                            ? "当前矩形会作为默认修复范围，补涂和擦除会在它的基础上细化蒙版。"
                            : "当前矩形只用于定位，不会自动参与修复；请用笔刷补涂真正需要修复的区域。"}{" "}
                          支持使用 Cmd/Ctrl + Z 撤销，Cmd/Ctrl + Shift + Z 或 Ctrl + Y 重做。
                        </div>
                      </>
                    )}
                  </div>
                )}

                {removeMode === "fill" && (
                  <div className="space-y-3 rounded-[10px] border border-slate-200 bg-slate-50 px-4 py-4">
                    <div className="text-sm font-medium text-slate-800">覆盖颜色</div>
                    <div className="flex items-center gap-3">
                      <label
                        className="relative block h-11 w-11 overflow-hidden rounded-[10px] border border-slate-200 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.8)]"
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
                    <div className="space-y-2 pt-1">
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-slate-500">覆盖透明度</span>
                        <span className="font-mono text-slate-700">{fillOpacity}%</span>
                      </div>
                      <Slider min={10} max={100} value={fillOpacity} onValueChange={setFillOpacity} />
                    </div>
                  </div>
                )}

                {removeMode === "blur" && (
                  <div className="space-y-3 rounded-[10px] border border-slate-200 bg-slate-50 px-4 py-4">
                    <div className="text-sm font-medium text-slate-800">模糊强度</div>
                    <div className="text-xs leading-5 text-slate-500">数值越高，遮挡越强，但边缘也会更容易显得发糊。</div>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-slate-500">当前强度</span>
                        <span className="font-mono text-slate-700">{blurStrength}</span>
                      </div>
                      <Slider min={4} max={30} value={blurStrength} onValueChange={setBlurStrength} />
                    </div>
                  </div>
                )}

                <div className="grid gap-3 rounded-[10px] border border-slate-200 bg-slate-50 px-4 py-4">
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
                  <div className="flex flex-wrap gap-2 border-t border-slate-200 pt-3">
                    <Button variant="secondary" size="sm" onClick={applyCornerWatermarkPreset}>
                      右下小水印
                    </Button>
                  </div>
                </div>

                {smartTips.slice(0, 2).map((tip, index) => (
                  <div
                    key={`${tip.title}-${index}`}
                    className={cn(
                      "space-y-3 rounded-[10px] border px-4 py-4",
                      tip.tone === "warning" && "border-amber-100 bg-amber-50/80",
                      tip.tone === "info" && "border-blue-100 bg-blue-50/75",
                      tip.tone === "success" && "border-emerald-100 bg-emerald-50/75"
                    )}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-medium text-slate-900">{tip.title}</div>
                        <div className="mt-1 text-xs leading-5 text-slate-600">{tip.description}</div>
                      </div>
                      <Badge tone={tip.tone === "warning" ? "warning" : tip.tone === "success" ? "success" : "info"}>
                        提示
                      </Badge>
                    </div>
                    {(tip.primaryAction || tip.secondaryAction) && (
                      <div className="flex flex-wrap gap-2">
                        {tip.primaryAction && (
                          <Button variant="secondary" size="sm" onClick={tip.primaryAction.onClick}>
                            {tip.primaryAction.label}
                          </Button>
                        )}
                        {tip.secondaryAction && (
                          <Button variant="secondary" size="sm" onClick={tip.secondaryAction.onClick}>
                            {tip.secondaryAction.label}
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                ))}

                <div className="rounded-[10px] border border-slate-200 bg-slate-50 px-4 py-4">
                  <div className="text-sm font-medium text-slate-800">同模板复用</div>
                  <div className="mt-2 text-xs leading-5 text-slate-500">
                    {simpleMode
                      ? "单张调好后，再把当前的模式和矩形配置复用到多张图片。建议只选择和当前图片尺寸一致、且水印位置一致的素材。"
                      : "单张调好后，再把当前的模式、矩形、空蒙版和笔刷修复配置复用到多张图片。建议只选择和当前图片尺寸一致、且水印位置一致的素材。"}
                  </div>
                  {processing && processingMode === "batch" ? (
                    <div className="mt-4 space-y-3">
                      <div className="rounded-[10px] border border-sky-100 bg-white/80 px-3 py-3">
                        <div className="flex items-center justify-between gap-3 text-xs text-slate-500">
                          <span className="truncate">{getBatchProgressText(batchProgress, processingDetail)}</span>
                          <span className="shrink-0">{Math.round(batchProgress?.percent ?? 0)}%</span>
                        </div>
                        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-200/80">
                          <div
                            className="h-full rounded-full bg-[var(--brand-600)] transition-all duration-300"
                            style={{ width: `${clamp(batchProgress?.percent ?? 0, 0, 100)}%` }}
                          />
                        </div>
                      </div>
                      <Button variant="secondary" className="w-full" onClick={() => void cancelBatchApply()}>
                        取消批量处理
                      </Button>
                    </div>
                  ) : (
                    <Button variant="secondary" className="mt-4 w-full" onClick={() => void handleBatchApply()} disabled={processing}>
                      批量应用当前配置
                    </Button>
                  )}
                </div>

                {result && (
                  <div className="space-y-3 rounded-[10px] border border-emerald-100 bg-emerald-50/70 px-4 py-4">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-sm font-medium text-emerald-900">最近输出</div>
                      <Badge tone="success">已生成</Badge>
                    </div>
                    <div className="break-all font-mono text-xs leading-5 text-emerald-900/80">{result.output_path}</div>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <Button variant="secondary" size="sm" onClick={() => void fileActions.openFile(result.output_path)}>
                        打开结果
                      </Button>
                      <Button variant="secondary" size="sm" onClick={() => void fileActions.revealInDir(result.output_path)}>
                        打开位置
                      </Button>
                      <Button variant="primary" size="sm" className="sm:col-span-2" onClick={() => void handleContinueRefine()}>
                        继续精修当前结果
                      </Button>
                    </div>
                    <div className="text-xs leading-5 text-emerald-900/70">
                      会保留当前模式和选区，并清空上一轮手工蒙版，方便在结果图上继续补涂或微调。
                    </div>
                  </div>
                )}

                {batchResults.length > 0 && (
                  <div className="space-y-3 rounded-[10px] border border-sky-100 bg-sky-50/70 px-4 py-4">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-sm font-medium text-sky-900">批量结果</div>
                      <Badge tone="info">
                        成功 {batchResults.filter((item) => item.success).length} / {batchResults.length}
                      </Badge>
                    </div>
                    <div className="max-h-56 space-y-2 overflow-auto pr-1">
                      {batchResults.map((item, index) => (
                        <div
                          key={`${item.output_path || item.message}-${index}`}
                          className={cn(
                            "rounded-[10px] border px-3 py-3",
                            item.success ? "border-emerald-100 bg-white/80" : "border-rose-100 bg-white/80"
                          )}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              <div className={cn("truncate text-sm font-medium", item.success ? "text-slate-900" : "text-rose-900")}>
                                {item.success ? item.output_path : item.message}
                              </div>
                              {item.success && <div className="mt-1 truncate text-xs text-slate-500">{item.message}</div>}
                            </div>
                            <Badge tone={item.success ? "success" : "danger"}>{item.success ? "成功" : "失败"}</Badge>
                          </div>
                          {item.success && item.output_path && (
                            <div className="mt-3 flex flex-wrap gap-2">
                              <Button variant="secondary" size="sm" onClick={() => void fileActions.openFile(item.output_path)}>
                                打开
                              </Button>
                              <Button variant="secondary" size="sm" onClick={() => void fileActions.revealInDir(item.output_path)}>
                                定位
                              </Button>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="space-y-3 border-t border-slate-100 pt-4">
                  <Button variant="primary" className="w-full" onClick={handleRemove} disabled={processing}>
                    {processing
                      ? "处理中…"
                      : simpleRepairNeedsPrecision
                        ? "当前范围偏大，先切到高级精修"
                        : removeMode === "repair"
                          ? "执行基础修复"
                          : "应用处理"}
                  </Button>
                  <Button
                    variant="secondary"
                    className="w-full"
                    onClick={() => {
                      setImage(null);
                      setBrushStrokes([]);
                      setHoverPoint(null);
                      setCompareHoverPoint(null);
                      setResult(null);
                      setBatchResults([]);
                      setResultPreview(null);
                      setLoadingResultPreview(false);
                    }}
                  >
                    重新选择
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>

          {(loadingResultPreview || resultPreview) && (
            <Card className="overflow-hidden">
              <CardHeader>
                <div>
                  <CardTitle>前后对比</CardTitle>
                  <div className="mt-1 text-sm text-slate-500">使用结果缩略图对比处理前后，拖动滑杆查看差异。</div>
                </div>
                <Badge tone="info">{loadingResultPreview ? "生成中" : "已更新"}</Badge>
              </CardHeader>
              <CardContent className="space-y-4">
                {loadingResultPreview || !resultPreview ? (
                  <div className="flex min-h-[220px] items-center justify-center rounded-[24px] border border-slate-200 bg-slate-50 text-sm text-slate-500">
                    正在生成对比预览…
                  </div>
                ) : (
                  <>
                    <div className="rounded-[24px] border border-slate-200 bg-slate-100 p-4">
                      <div
                        className="relative mx-auto w-full max-w-[760px] overflow-hidden rounded-[20px] bg-slate-950/5 cursor-crosshair"
                        style={{ aspectRatio: `${image.width} / ${image.height}` }}
                        onMouseMove={handleCompareMouseMove}
                        onMouseLeave={handleCompareMouseLeave}
                      >
                        <img src={getPreviewImageSrc(image)} alt="原图" className="absolute inset-0 h-full w-full object-contain" />
                        <div className="absolute inset-y-0 left-0 overflow-hidden" style={{ width: `${compareSplit}%` }}>
                          <img src={getPreviewImageSrc(resultPreview)} alt="处理后" className="absolute inset-0 h-full w-full object-contain" />
                        </div>
                        <div className="absolute left-3 top-3 rounded-full bg-white/88 px-3 py-1 text-xs font-medium text-slate-700 shadow-[0_6px_16px_rgba(15,23,42,0.12)]">
                          原图
                        </div>
                        <div className="absolute right-3 top-3 rounded-full bg-slate-900/78 px-3 py-1 text-xs font-medium text-white shadow-[0_6px_16px_rgba(15,23,42,0.24)]">
                          处理后
                        </div>
                        <div className="pointer-events-none absolute inset-y-0 z-10" style={{ left: `calc(${compareSplit}% - 1px)` }}>
                          <div className="relative h-full w-0.5 bg-white shadow-[0_0_0_1px_rgba(15,23,42,0.08),0_0_18px_rgba(255,255,255,0.5)]">
                            <div className="absolute left-1/2 top-1/2 flex h-9 w-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-white/80 bg-white text-slate-700 shadow-[0_10px_30px_rgba(15,23,42,0.16)]">
                              ⇆
                            </div>
                          </div>
                        </div>
                        {compareHoverPoint && (
                          <div
                            className="pointer-events-none absolute z-20"
                            style={{
                              left: compareHoverPoint.x,
                              top: compareHoverPoint.y,
                              transform: "translate(-50%, -50%)",
                            }}
                          >
                            <div className="relative flex h-8 w-8 items-center justify-center rounded-full border border-white/85 bg-white/30 shadow-[0_8px_24px_rgba(15,23,42,0.14)] backdrop-blur-[1px]">
                              <div className="absolute inset-x-1 top-1/2 h-px -translate-y-1/2 bg-white/95" />
                              <div className="absolute inset-y-1 left-1/2 w-px -translate-x-1/2 bg-white/95" />
                            </div>
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                      <Slider min={0} max={100} value={compareSplit} onValueChange={setCompareSplit} />
                      <Badge tone="default">处理后显示 {compareSplit}%</Badge>
                    </div>

                    <div className="rounded-[24px] border border-slate-200 bg-slate-50 px-4 py-4">
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <div className="text-sm font-medium text-slate-800">局部前后放大对比</div>
                        <Badge tone="default">{(COMPARE_MAGNIFIER_SIZE / COMPARE_MAGNIFIER_SAMPLE_SIZE).toFixed(1)}x</Badge>
                      </div>
                      <div className="grid gap-3 md:grid-cols-2">
                        <div className="rounded-[10px] border border-slate-200 bg-white p-3">
                          <div className="mb-2 text-xs font-medium text-slate-500">原图局部</div>
                          {compareHoverPoint ? (
                            <canvas
                              ref={compareOriginalMagnifierRef}
                              className="mx-auto h-44 w-44 rounded-[10px] border border-slate-200 bg-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.85)]"
                            />
                          ) : (
                            <div className="mx-auto flex h-44 w-44 items-center justify-center rounded-[10px] border border-dashed border-slate-200 bg-slate-50 text-center text-xs leading-5 text-slate-400">
                              将鼠标移到上方对比图
                              <br />
                              查看原图局部
                            </div>
                          )}
                        </div>
                        <div className="rounded-[10px] border border-slate-200 bg-white p-3">
                          <div className="mb-2 text-xs font-medium text-slate-500">处理后局部</div>
                          {compareHoverPoint ? (
                            <canvas
                              ref={compareResultMagnifierRef}
                              className="mx-auto h-44 w-44 rounded-[10px] border border-slate-200 bg-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.85)]"
                            />
                          ) : (
                            <div className="mx-auto flex h-44 w-44 items-center justify-center rounded-[10px] border border-dashed border-slate-200 bg-slate-50 text-center text-xs leading-5 text-slate-400">
                              将鼠标移到上方对比图
                              <br />
                              查看修复后局部
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="mt-3 text-xs leading-5 text-slate-500">
                        {compareHoverPoint
                          ? `当前检查位置 ${Math.round(compareHoverPoint.ox)}, ${Math.round(compareHoverPoint.oy)}`
                          : "适合检查修复边缘、细字笔画和颜色过渡。"}
                      </div>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
