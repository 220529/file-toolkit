import { invoke } from "@tauri-apps/api/core";

export interface ImageInfo {
  width: number;
  height: number;
  path: string;
  thumbnail: string;
}

export interface WatermarkResult {
  success: boolean;
  output_path: string;
  message: string;
}

export interface WatermarkBatchResult {
  cancelled: boolean;
  items: WatermarkResult[];
}

export interface WatermarkBatchProgress {
  task_id: string;
  stage: string;
  current: number;
  total: number;
  percent: number;
  current_file: string;
  succeeded: number;
  failed: number;
}

export interface BrushStroke {
  x: number;
  y: number;
  size: number;
  erase: boolean;
  start: boolean;
}

export type WatermarkMode = "blur" | "fill" | "repair";
export type RepairMaskBase = "rect" | "blank";

export interface WatermarkOptions {
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  fillOpacity: number;
  blurStrength: number;
  mode: WatermarkMode;
  repairBaseMode: RepairMaskBase;
  brushStrokes: BrushStroke[];
  brushSize: number;
}

export interface RemoveWatermarkRequest extends WatermarkOptions {
  inputPath: string;
}

export interface BatchRemoveWatermarkRequest extends WatermarkOptions {
  taskId: string;
  inputPaths: string[];
  expectedWidth: number;
  expectedHeight: number;
}

export function getImageInfo(path: string) {
  return invoke<ImageInfo>("get_image_info", { path });
}

export function removeWatermark(request: RemoveWatermarkRequest) {
  return invoke<WatermarkResult>("remove_watermark", { ...request });
}

export function batchRemoveWatermark(request: BatchRemoveWatermarkRequest) {
  return invoke<WatermarkBatchResult>("batch_remove_watermark", { ...request });
}

export function cancelWatermarkTask(taskId: string) {
  return invoke<void>("cancel_watermark_task", { taskId });
}
