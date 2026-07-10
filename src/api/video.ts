import { invoke } from "@tauri-apps/api/core";

export interface VideoInfo {
  duration: number;
  width: number;
  height: number;
  fps: number;
}

export interface BatchVideoFile {
  path: string;
  name: string;
  size: number;
}

export interface BatchTrimProgress {
  task_id: string;
  stage: string;
  current: number;
  total: number;
  percent: number;
  current_file: string;
  item_progress: number;
  succeeded: number;
  skipped: number;
  failed: number;
}

export interface BatchTrimItemResult {
  input_path: string;
  output_path: string | null;
  status: "success" | "skipped" | "failed";
  message: string;
}

export interface BatchTrimResult {
  total: number;
  succeeded: number;
  skipped: number;
  failed: number;
  cancelled: boolean;
  items: BatchTrimItemResult[];
}

export function getVideoInfo(path: string) {
  return invoke<VideoInfo>("get_video_info", { path });
}

export function collectBatchVideoFiles(inputs: string[]) {
  return invoke<BatchVideoFile[]>("collect_batch_video_files", { inputs });
}

export function generatePreviewFrame(path: string, time: number) {
  return invoke<string>("generate_preview_frame", { path, time });
}

export function generateTimelineFrames(path: string, count: number) {
  return invoke<string[]>("generate_timeline_frames", { path, count });
}

export interface CutVideoRequest {
  taskId: string;
  input: string;
  output: string;
  startTime: number;
  endTime: number;
  precise: boolean;
}

export function cutVideo({ precise, ...request }: CutVideoRequest) {
  return invoke<string>(precise ? "cut_video_precise" : "cut_video", request);
}

export interface VideoProgress {
  task_id: string;
  percent: number;
}

export function cancelVideoCut(taskId: string) {
  return invoke<void>("cancel_video_cut", { taskId });
}

export type VideoConvertFormat = "mp4" | "mov" | "gif";
export type VideoConvertQuality = "high" | "medium" | "low";

export interface ConvertProgress {
  task_id: string;
  percent: number;
}

export interface ConvertVideoRequest {
  taskId: string;
  input: string;
  output: string;
  format: VideoConvertFormat;
  quality: VideoConvertQuality;
}

export function getFileSize(path: string) {
  return invoke<number>("get_file_size", { path });
}

export function convertVideo(request: ConvertVideoRequest) {
  return invoke<string>("convert_video", { ...request });
}

export function cancelConvert(taskId: string) {
  return invoke<void>("cancel_convert", { taskId });
}

export type BatchTrimOutputMode = "source" | "directory";

export interface BatchTrimVideosRequest {
  taskId: string;
  paths: string[];
  trimStart: number;
  preciseMode: boolean;
  outputMode: BatchTrimOutputMode;
  outputDir: string | null;
  suffix: string;
}

export function batchTrimVideos(request: BatchTrimVideosRequest) {
  return invoke<BatchTrimResult>("batch_trim_videos", { ...request });
}

export function cancelBatchVideoTrim(taskId: string) {
  return invoke<void>("cancel_batch_video_trim", { taskId });
}
