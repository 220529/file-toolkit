import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  batchRemoveWatermark,
  cancelWatermarkTask,
  getImageInfo,
  removeWatermark,
  type ImageInfo,
  type WatermarkBatchProgress,
  type WatermarkResult as Result,
} from "../api/tauri";
import { useTaskReporter } from "../components/TaskCenter";
import { useToast } from "../components/Toast";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Slider } from "../components/ui/slider";
import { Switch } from "../components/ui/switch";
import { useFileActions } from "../hooks/useFileActions";
import { useWindowDrop } from "../hooks/useWindowDrop";
import { cn } from "../utils/cn";
import { createTaskId } from "../utils/id";
import { getBaseName, getExtension } from "../utils/path";
import { safeListen } from "../utils/tauriEvent";
import { drawBrushMaskPreview, drawImageMagnifier } from "./watermark/canvasUtils";
import {
  COMPARE_MAGNIFIER_SAMPLE_SIZE,
  COMPARE_MAGNIFIER_SIZE,
  MAGNIFIER_SAMPLE_SIZE,
  MAGNIFIER_SIZE,
  MAX_BRUSH_SIZE,
  MIN_BRUSH_SIZE,
} from "./watermark/constants";
import type {
  CanvasPoint,
  ComparePoint,
  DragMode,
  EditorMode,
  LoadImageOptions,
  RectSelection,
  RemoveMode,
  RepairMaskBase,
  RepairTool,
} from "./watermark/types";
import {
  clamp,
  clampRectToImage,
  getBatchProgressText,
  getCornerWatermarkRect,
  getDefaultRect,
  getPreviewImageSrc,
} from "./watermark/utils";
import { getWatermarkViewState } from "./watermark/viewState";
import { buildWatermarkSmartTips } from "./watermark/smartTips";
import { WatermarkDropCard } from "./watermark/WatermarkDropCard";
import { WatermarkResultActions } from "./watermark/WatermarkResultActions";
import { WatermarkResultCompare } from "./watermark/WatermarkResultCompare";
import { WatermarkSmartTips } from "./watermark/WatermarkSmartTips";
import { useBrushMask } from "./watermark/useBrushMask";

interface Props {
  active: boolean;
}

export default function Watermark({ active }: Props) {
  const [image, setImage] = useState<ImageInfo | null>(null);
  const [rect, setRect] = useState<RectSelection>({ x: 0, y: 0, w: 100, h: 30 });
  const [fillColor, setFillColor] = useState("#ffffff");
  const [fillOpacity, setFillOpacity] = useState(100);
  const [blurStrength, setBlurStrength] = useState(15);
  const [processing, setProcessing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [processingMode, setProcessingMode] = useState<"single" | "batch" | null>(null);
  const [processingDetail, setProcessingDetail] = useState("");
  const [batchProgress, setBatchProgress] = useState<WatermarkBatchProgress | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectingBatch, setSelectingBatch] = useState(false);
  const [editorMode, setEditorMode] = useState<EditorMode>("simple");
  const [removeMode, setRemoveMode] = useState<RemoveMode>("repair");
  const [dragMode, setDragMode] = useState<DragMode>("none");
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [rectStart, setRectStart] = useState<RectSelection>({ x: 0, y: 0, w: 0, h: 0 });
  const [scale, setScale] = useState(1);
  const [repairTool, setRepairTool] = useState<RepairTool>("rect");
  const [repairMaskBase, setRepairMaskBase] = useState<RepairMaskBase>("rect");
  const [painting, setPainting] = useState(false);
  const [hoverPoint, setHoverPoint] = useState<CanvasPoint | null>(null);
  const [compareHoverPoint, setCompareHoverPoint] = useState<ComparePoint | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [batchResults, setBatchResults] = useState<Result[]>([]);
  const [batchSummary, setBatchSummary] = useState<{ total: number; cancelled: boolean } | null>(null);
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
  const processingRef = useRef(false);
  const loadingImageRef = useRef(false);
  const selectingBatchRef = useRef(false);
  const imageLoadGenerationRef = useRef(0);
  const resultPreviewGenerationRef = useRef(0);
  const [originalCompareReady, setOriginalCompareReady] = useState(false);
  const [resultCompareReady, setResultCompareReady] = useState(false);
  const toast = useToast();
  const task = useTaskReporter("watermark");
  const fileActions = useFileActions();
  const simpleMode = editorMode === "simple";
  const interactionLocked = processing || loading || selectingBatch;
  const activeRepairTool: RepairTool = simpleMode ? "rect" : repairTool;
  const activeRepairMaskBase: RepairMaskBase = simpleMode ? "rect" : repairMaskBase;
  const {
    brushSize,
    setBrushSize,
    activeBrushStrokes,
    hasMaskEdits,
    brushGestureCount,
    canRedoBrushStroke,
    addBrushStroke,
    handleUndoBrushStroke,
    handleRedoBrushStroke,
    clearBrushStrokes,
    clearBrushMask,
  } = useBrushMask({ active, simpleMode, removeMode, processing: interactionLocked });
  const { dragging } = useWindowDrop({
    active: active && !processing && !loading && !selectingBatch,
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
    if (processingRef.current || loadingImageRef.current || selectingBatchRef.current) return;

    const ext = getExtension(path).toLowerCase();
    if (!["png", "jpg", "jpeg", "webp"].includes(ext)) {
      toast.warning("当前仅支持 PNG、JPG、JPEG、WEBP");
      return;
    }

    const requestGeneration = ++imageLoadGenerationRef.current;
    resultPreviewGenerationRef.current += 1;
    loadingImageRef.current = true;
    setLoading(true);
    try {
      const info = await getImageInfo(path);
      if (requestGeneration !== imageLoadGenerationRef.current) return;
      const preserveEditContext = options?.preserveEditContext && image;
      setImage(info);
      setRect(preserveEditContext ? clampRectToImage(rect, info) : getDefaultRect(info));
      clearBrushMask();
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
      setBatchSummary(null);
      setResultPreview(null);
      setLoadingResultPreview(false);
      setCompareSplit(50);
      if (preserveEditContext) {
        toast.info("已载入结果图，保留当前模式和选区，可继续精修");
      }
    } catch (error) {
      if (requestGeneration !== imageLoadGenerationRef.current) return;
      console.error("加载图片失败:", error);
      toast.error("加载图片失败: " + error);
    } finally {
      if (requestGeneration === imageLoadGenerationRef.current) {
        loadingImageRef.current = false;
        setLoading(false);
      }
    }
  }

  async function handleSelectFile() {
    if (processingRef.current || loadingImageRef.current || selectingBatchRef.current) return;

    const selected = await open({
      multiple: false,
      filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp"] }],
    });
    if (selected && typeof selected === "string") {
      await loadImage(selected);
    }
  }

  async function handleContinueRefine() {
    if (processingRef.current || loadingImageRef.current || !result?.output_path) return;
    await loadImage(result.output_path, { preserveEditContext: true });
  }

  function switchToPreciseRepair() {
    setEditorMode("advanced");
    setRepairMaskBase("blank");
    setRepairTool("brush");
    clearBrushMask();
  }

  function applyCornerWatermarkPreset() {
    if (!image) return;

    setRect(getCornerWatermarkRect(image));
    setRemoveMode("repair");
    setEditorMode("simple");
    setRepairMaskBase("rect");
    setRepairTool("rect");
    clearBrushMask();
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

  async function loadResultPreview(path: string) {
    const requestGeneration = ++resultPreviewGenerationRef.current;
    setCompareHoverPoint(null);
    setResultPreview(null);
    setLoadingResultPreview(true);
    try {
      const info = await getImageInfo(path);
      if (requestGeneration !== resultPreviewGenerationRef.current) return;
      setResultPreview(info);
    } catch (error) {
      if (requestGeneration !== resultPreviewGenerationRef.current) return;
      console.error("加载结果预览失败:", error);
      setResultPreview(null);
      toast.warning("结果已生成，但前后对比预览加载失败");
    } finally {
      if (requestGeneration === resultPreviewGenerationRef.current) {
        setLoadingResultPreview(false);
      }
    }
  }

  function handleMouseDown(event: React.MouseEvent) {
    if (interactionLocked) return;

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
    if (interactionLocked) return;

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
    if (!image || processingRef.current || loadingImageRef.current || selectingBatchRef.current) return;
    if (simpleRepairNeedsPrecision) {
      switchToPreciseRepair();
      toast.warning(`当前选区约占整图 ${selectionAreaPercent}%，简洁模式直接修复容易出现明显糊块，已切到高级精修`);
      return;
    }

    processingRef.current = true;
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
      setBatchSummary(null);
      setCompareSplit(50);
      toast.success(response.message);
      void loadResultPreview(response.output_path);
    } catch (error) {
      toast.error("处理失败: " + error);
    } finally {
      processingRef.current = false;
      setProcessing(false);
      setProcessingMode(null);
      setProcessingDetail("");
    }
  }

  async function handleBatchApply() {
    if (!image || processingRef.current || loadingImageRef.current || selectingBatchRef.current) return;
    if (simpleRepairNeedsPrecision) {
      switchToPreciseRepair();
      toast.warning(`当前选区约占整图 ${selectionAreaPercent}%，不建议直接批量基础修复，已切到高级精修`);
      return;
    }

    selectingBatchRef.current = true;
    setSelectingBatch(true);
    let selected: string | string[] | null;
    try {
      selected = await open({
        multiple: true,
        filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp"] }],
      });
    } finally {
      selectingBatchRef.current = false;
      setSelectingBatch(false);
    }

    const inputPaths =
      typeof selected === "string" ? [selected] : Array.isArray(selected) ? selected.filter((item): item is string => typeof item === "string") : [];

    if (!inputPaths.length || processingRef.current || loadingImageRef.current) return;

    const taskId = createTaskId("watermark");
    currentTaskIdRef.current = taskId;
    processingRef.current = true;
    setCancelling(false);
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
    setBatchSummary(null);

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
      setBatchResults(response.items);
      setBatchSummary({ total: inputPaths.length, cancelled: response.cancelled });
      const succeeded = response.items.filter((item) => item.success).length;
      const failed = response.items.length - succeeded;
      if (response.cancelled) {
        toast.info(`已取消批量处理；取消前成功 ${succeeded} 张${failed > 0 ? `，失败 ${failed} 张` : ""}`);
      } else if (failed === 0) {
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
      processingRef.current = false;
      setCancelling(false);
      setProcessing(false);
      setProcessingMode(null);
      setProcessingDetail("");
      setBatchProgress(null);
    }
  }

  async function cancelBatchApply() {
    const taskId = currentTaskIdRef.current;
    if (!taskId || cancelling) return;

    setCancelling(true);
    try {
      await cancelWatermarkTask(taskId);
    } catch (error) {
      setCancelling(false);
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
        cancelling
          ? "正在取消，等待当前步骤收尾"
          : processingMode === "batch"
          ? batchProgress?.stage || "正在批量应用当前配置"
          : removeMode === "repair"
            ? "正在执行基础修复"
            : "正在应用处理",
      detail:
        processingMode === "batch"
          ? getBatchProgressText(batchProgress, processingDetail)
          : processingDetail || (image ? getBaseName(image.path) : "等待图片"),
      progress: processingMode === "batch" ? batchProgress?.percent : undefined,
      cancellable: processingMode === "batch" && !cancelling,
      onCancel: processingMode === "batch" && !cancelling ? cancelBatchApply : undefined,
    });
  }, [batchProgress, cancelling, image, processing, processingDetail, processingMode, removeMode]);

  const {
    canvasHint,
    magnifierZoom,
    selectionAreaRatio,
    simpleRepairNeedsPrecision,
    selectionAreaPercent,
    manualStrokeCount,
    primaryActionLabel,
  } = getWatermarkViewState({
    imageWidth: image?.width ?? 0,
    imageHeight: image?.height ?? 0,
    rect,
    removeMode,
    simpleMode,
    activeRepairTool,
    activeRepairMaskBase,
    brushGestureCount,
    processing,
  });
  const smartTips = buildWatermarkSmartTips({
    removeMode,
    simpleMode,
    activeRepairTool,
    activeRepairMaskBase,
    simpleRepairNeedsPrecision,
    selectionAreaPercent,
    selectionAreaRatio,
    manualStrokeCount,
    hasResult: Boolean(result?.output_path),
    actions: {
      openAdvancedMode: () => setEditorMode("advanced"),
      switchToPreciseRepair,
      switchToBrush: () => setRepairTool("brush"),
      switchToErase: () => setRepairTool("erase"),
      switchToBlankBrush: () => {
        setRepairMaskBase("blank");
        setRepairTool("brush");
      },
      continueRefine: () => {
        void handleContinueRefine();
      },
      switchToRepairMode: () => setRemoveMode("repair"),
    },
  });

  return (
    <div className="mx-auto max-w-[1360px] space-y-4">
      <WatermarkDropCard
        dragging={dragging}
        loading={loading}
        disabled={processing || loading || selectingBatch}
        onSelectFile={handleSelectFile}
      />

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
                      aria-disabled={interactionLocked}
                      className={cn("max-w-full", processing && "pointer-events-none opacity-60")}
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
                    <Switch
                      checked={!simpleMode}
                      disabled={interactionLocked}
                      onCheckedChange={(checked) => setEditorMode(checked ? "advanced" : "simple")}
                    />
                  </label>
                </div>
              </CardHeader>
              <CardContent className="space-y-5">
                <fieldset
                  disabled={interactionLocked}
                  className={cn(
                    "space-y-5",
                    interactionLocked && "pointer-events-none opacity-60"
                  )}
                >
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
                            disabled={interactionLocked}
                          />
                        </div>

                        <div className="flex flex-wrap gap-2">
                          <Button variant="secondary" size="sm" onClick={handleUndoBrushStroke} disabled={interactionLocked || !hasMaskEdits}>
                            撤销一步
                          </Button>
                          <Button variant="secondary" size="sm" onClick={handleRedoBrushStroke} disabled={interactionLocked || !canRedoBrushStroke}>
                            重做一步
                          </Button>
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={clearBrushMask}
                            disabled={interactionLocked || !hasMaskEdits}
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
                      <Slider min={10} max={100} value={fillOpacity} onValueChange={setFillOpacity} disabled={interactionLocked} />
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
                      <Slider min={4} max={30} value={blurStrength} onValueChange={setBlurStrength} disabled={interactionLocked} />
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

                <WatermarkSmartTips tips={smartTips} />
                </fieldset>

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
                      <Button
                        variant="secondary"
                        className="w-full"
                        onClick={() => void cancelBatchApply()}
                        disabled={cancelling}
                      >
                        {cancelling ? "正在取消..." : "取消批量处理"}
                      </Button>
                    </div>
                  ) : (
                    <Button
                      variant="secondary"
                      className="mt-4 w-full"
                      onClick={() => void handleBatchApply()}
                      disabled={interactionLocked}
                    >
                      {selectingBatch ? "正在选择图片..." : "批量应用当前配置"}
                    </Button>
                  )}
                </div>

                <WatermarkResultActions
                  result={result}
                  batchResults={batchResults}
                  batchSummary={batchSummary}
                  disabled={interactionLocked}
                  onOpenFile={fileActions.openFile}
                  onRevealInDir={fileActions.revealInDir}
                  onContinueRefine={handleContinueRefine}
                />

                <div className="space-y-3 border-t border-slate-100 pt-4">
                  <Button
                    variant="primary"
                    className="w-full"
                    onClick={handleRemove}
                    disabled={interactionLocked}
                  >
                    {primaryActionLabel}
                  </Button>
                  <Button
                    variant="secondary"
                    className="w-full"
                    disabled={interactionLocked}
                    onClick={() => {
                      imageLoadGenerationRef.current += 1;
                      resultPreviewGenerationRef.current += 1;
                      setImage(null);
                      clearBrushStrokes();
                      setHoverPoint(null);
                      setCompareHoverPoint(null);
                      setResult(null);
                      setBatchResults([]);
                      setBatchSummary(null);
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
            <WatermarkResultCompare
              image={image}
              resultPreview={resultPreview}
              loadingResultPreview={loadingResultPreview}
              compareSplit={compareSplit}
              compareHoverPoint={compareHoverPoint}
              compareOriginalMagnifierRef={compareOriginalMagnifierRef}
              compareResultMagnifierRef={compareResultMagnifierRef}
              onCompareMouseMove={handleCompareMouseMove}
              onCompareMouseLeave={handleCompareMouseLeave}
              onCompareSplitChange={setCompareSplit}
            />
          )}
        </div>
      )}
    </div>
  );
}
