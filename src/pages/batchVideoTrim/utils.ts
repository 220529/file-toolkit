import type { BatchTrimProgress, VideoInfo } from "../../api/tauri";

export type OutputMode = "source" | "directory";
export type PreviewStrategy = "video" | "image";
export type FrameSnapStrategy = "nearest" | "floor" | "ceil";

export const SUPPORTED_VIDEO_EXTENSIONS = ["mp4", "mov", "avi", "mkv", "wmv", "flv", "webm"];
export const BATCH_OUTPUT_DIR_STORAGE_KEY = "batch-video-trim-output-dir";

export function formatTime(seconds: number) {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(totalMs / 3_600_000);
  const m = Math.floor((totalMs % 3_600_000) / 60_000);
  const s = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}.${ms.toString().padStart(3, "0")}`;
  }
  return `${m}:${s.toString().padStart(2, "0")}.${ms.toString().padStart(3, "0")}`;
}

export function parseTimeInput(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^\d+(?:\.\d+)?(?::\d+(?:\.\d+)?){0,2}$/.test(trimmed)) return null;

  const parts = trimmed.split(":").map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part) || part < 0)) return null;

  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0];
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function getFrameDuration(fps: number) {
  if (!Number.isFinite(fps) || fps <= 0) return 1 / 30;
  return 1 / clamp(fps, 1, 120);
}

export function snapTimeToFrame(time: number, info: VideoInfo | null, strategy: FrameSnapStrategy = "nearest") {
  if (!info) return Math.max(0, time);
  const duration = Math.max(0, info.duration);
  if (duration <= 0) return 0;
  if (time <= 0) return 0;
  if (time >= duration) return duration;

  const frameDuration = getFrameDuration(info.fps);
  const frameIndex = time / frameDuration;
  const snappedIndex =
    strategy === "floor" ? Math.floor(frameIndex) : strategy === "ceil" ? Math.ceil(frameIndex) : Math.round(frameIndex);
  return clamp(snappedIndex * frameDuration, 0, duration);
}

export function getPreferredPreviewStrategy(path: string): PreviewStrategy {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  return ["mp4", "mov", "webm"].includes(ext) ? "video" : "image";
}

export function getProgressText(progress: BatchTrimProgress | null) {
  if (!progress) return "等待开始";
  const segments = [
    `第 ${Math.max(0, Math.min(progress.current, progress.total))}/${progress.total || 0} 个`,
    `${progress.succeeded} 成功`,
  ];
  if (progress.skipped > 0) segments.push(`${progress.skipped} 跳过`);
  if (progress.failed > 0) segments.push(`${progress.failed} 失败`);
  if (progress.current_file) segments.push(progress.current_file);
  return segments.join(" · ");
}
