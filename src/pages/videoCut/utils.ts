import type { VideoInfo } from "../../api/tauri";
import { getExtension } from "../../utils/path";

export const SUPPORTED_VIDEO_EXTENSIONS = ["mp4", "mov", "avi", "mkv", "wmv", "flv", "webm"];

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

export function formatTimeForFilename(seconds: number) {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(totalMs / 3_600_000);
  const m = Math.floor((totalMs % 3_600_000) / 60_000);
  const s = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  if (h > 0) {
    return `${h.toString().padStart(2, "0")}h${m.toString().padStart(2, "0")}m${s.toString().padStart(2, "0")}s${ms.toString().padStart(3, "0")}ms`;
  }
  return `${m.toString().padStart(2, "0")}m${s.toString().padStart(2, "0")}s${ms.toString().padStart(3, "0")}ms`;
}

export function formatSignedOffsetLabel(seconds: number) {
  return seconds >= 0 ? `+${formatTime(seconds)}` : `-${formatTime(Math.abs(seconds))}`;
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

export function getMinClipDuration(duration: number, fps: number) {
  if (duration <= 0) return 0;
  return Math.min(getFrameDuration(fps), duration);
}

export function getFrameDuration(fps: number) {
  if (!Number.isFinite(fps) || fps <= 0) return 1 / 30;
  const normalizedFps = clamp(fps, 1, 120);
  return 1 / normalizedFps;
}

export function getFrameNumber(time: number, info: VideoInfo | null) {
  if (!info) return 0;
  const frameDuration = getFrameDuration(info.fps);
  return Math.max(1, Math.round(time / frameDuration) + 1);
}

export function getClipFrameCount(start: number, end: number, info: VideoInfo | null) {
  if (!info) return 0;
  const frameDuration = getFrameDuration(info.fps);
  return Math.max(1, Math.round((end - start) / frameDuration));
}

export function snapTimeToFrame(
  time: number,
  info: VideoInfo | null,
  strategy: "nearest" | "floor" | "ceil" = "nearest"
) {
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

export function formatFps(fps: number) {
  if (!Number.isFinite(fps) || fps <= 0) return "30";
  return fps.toFixed(2).replace(/\.?0+$/, "");
}

export function getTimelineFrameCount(duration: number, width: number) {
  const minCount =
    duration <= 30 ? 8 :
    duration <= 2 * 60 ? 10 :
    duration <= 10 * 60 ? 12 :
    duration <= 30 * 60 ? 14 :
    16;

  if (width <= 0) return minCount;

  const widthBasedCount = Math.round(width / 92);
  return clamp(widthBasedCount, minCount, 24);
}

export function getPreferredPreviewStrategy(path: string): "video" | "image" {
  const ext = getExtension(path).toLowerCase();
  return ["mp4", "mov", "webm"].includes(ext) ? "video" : "image";
}

export function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

export function getPreferredPreciseOutputExtension(ext: string) {
  const normalizedExt = ext.toLowerCase();
  if (["mp4", "mov", "m4v", "mkv"].includes(normalizedExt)) {
    return normalizedExt;
  }
  return "mp4";
}

export function isSupportedPreciseOutputExtension(ext: string) {
  return ["mp4", "mov", "m4v", "mkv"].includes(ext.toLowerCase());
}

export function ensureOutputPathExtension(path: string, ext: string) {
  return getExtension(path) ? path : `${path}.${ext}`;
}
