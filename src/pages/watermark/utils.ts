import { convertFileSrc } from "@tauri-apps/api/core";
import type { BrushStroke, ImageInfo, WatermarkBatchProgress } from "../../api/tauri";
import { MIN_RECT_SIZE } from "./constants";
import type { RectSelection } from "./types";

export function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function clampRectToImage(nextRect: RectSelection, image: ImageInfo) {
  const minWidth = Math.min(MIN_RECT_SIZE, image.width);
  const minHeight = Math.min(MIN_RECT_SIZE, image.height);
  const width = clamp(Math.round(nextRect.w), minWidth, image.width);
  const height = clamp(Math.round(nextRect.h), minHeight, image.height);
  const x = clamp(Math.round(nextRect.x), 0, Math.max(0, image.width - width));
  const y = clamp(Math.round(nextRect.y), 0, Math.max(0, image.height - height));

  return { x, y, w: width, h: height };
}

export function getCornerWatermarkRect(image: ImageInfo) {
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

export function getDefaultRect(image: ImageInfo) {
  return getCornerWatermarkRect(image);
}

export function splitBrushGestures(strokes: BrushStroke[]) {
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

export function flattenBrushGestures(gestures: BrushStroke[][]) {
  return gestures.reduce<BrushStroke[]>((all, gesture) => all.concat(gesture), []);
}

export function getPreviewImageSrc(image: ImageInfo) {
  return image.thumbnail || convertFileSrc(image.path);
}

export function getBrushDiameter(stroke: BrushStroke, fallbackSize: number) {
  return Math.max(1, stroke.size || fallbackSize);
}

export function getBatchProgressText(progress: WatermarkBatchProgress | null, fallbackDetail: string) {
  if (!progress) return fallbackDetail;
  const segments = [`已完成 ${progress.current} / ${progress.total || 0}`, `${progress.succeeded} 成功`];
  if (progress.failed > 0) segments.push(`${progress.failed} 失败`);
  if (progress.current_file) segments.push(progress.current_file);
  return segments.join(" · ");
}
