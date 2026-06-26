import {
  MAGNIFIER_SAMPLE_SIZE,
  MAGNIFIER_SIZE,
  SIMPLE_REPAIR_MAX_AREA_RATIO,
} from "./constants";
import type { RectSelection, RemoveMode, RepairMaskBase, RepairTool } from "./types";

interface WatermarkViewStateInput {
  imageWidth: number;
  imageHeight: number;
  rect: RectSelection;
  removeMode: RemoveMode;
  simpleMode: boolean;
  activeRepairTool: RepairTool;
  activeRepairMaskBase: RepairMaskBase;
  brushGestureCount: number;
  processing: boolean;
}

export function getWatermarkViewState({
  imageWidth,
  imageHeight,
  rect,
  removeMode,
  simpleMode,
  activeRepairTool,
  activeRepairMaskBase,
  brushGestureCount,
  processing,
}: WatermarkViewStateInput) {
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
  const imageArea = imageWidth > 0 && imageHeight > 0 ? imageWidth * imageHeight : 0;
  const selectionAreaRatio = imageArea > 0 ? (rect.w * rect.h) / imageArea : 0;
  const simpleRepairNeedsPrecision = removeMode === "repair" && simpleMode && selectionAreaRatio > SIMPLE_REPAIR_MAX_AREA_RATIO;
  const selectionAreaPercent = (selectionAreaRatio * 100).toFixed(1);
  const manualStrokeCount = brushGestureCount;
  const primaryActionLabel = processing
    ? "处理中…"
    : simpleRepairNeedsPrecision
      ? "当前范围偏大，先切到高级精修"
      : removeMode === "repair"
        ? "执行基础修复"
        : "应用处理";

  return {
    canvasHint,
    magnifierZoom,
    selectionAreaRatio,
    simpleRepairNeedsPrecision,
    selectionAreaPercent,
    manualStrokeCount,
    primaryActionLabel,
  };
}
