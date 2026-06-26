import type { VideoInfo } from "../../api/tauri";
import {
  clamp,
  formatSignedOffsetLabel,
  getClipFrameCount,
  getFrameNumber,
  getTimelineFrameCount,
} from "./utils";

type TimelineDragMode = "playhead" | "start" | "end";

interface VideoCutViewStateInput {
  videoInfo: VideoInfo | null;
  startTime: number;
  endTime: number;
  currentPreviewTime: number;
  hoverTimelineTime: number | null;
  timelineWidth: number;
  timelineDragMode: TimelineDragMode | null;
  processing: boolean;
  previewStrategy: "video" | "image";
  previewReady: boolean;
  clipPlaybackActive: boolean;
}

export function getVideoCutViewState({
  videoInfo,
  startTime,
  endTime,
  currentPreviewTime,
  hoverTimelineTime,
  timelineWidth,
  timelineDragMode,
  processing,
  previewStrategy,
  previewReady,
  clipPlaybackActive,
}: VideoCutViewStateInput) {
  const clipDuration = Math.max(0, endTime - startTime);
  const timelineFrameTargetCount = videoInfo ? getTimelineFrameCount(videoInfo.duration, timelineWidth) : 0;
  const currentPreviewFrameNumber = getFrameNumber(currentPreviewTime, videoInfo);
  const startFrameNumber = getFrameNumber(startTime, videoInfo);
  const endFrameNumber = getFrameNumber(endTime, videoInfo);
  const clipFrameCount = getClipFrameCount(startTime, endTime, videoInfo);
  const currentPreviewInClip = currentPreviewTime >= startTime && currentPreviewTime <= endTime;
  const offsetFromStart = currentPreviewInClip ? currentPreviewTime - startTime : null;
  const offsetToEnd = currentPreviewInClip ? endTime - currentPreviewTime : null;
  const clipProgressPercent = currentPreviewInClip && clipDuration > 0 ? ((currentPreviewTime - startTime) / clipDuration) * 100 : null;
  const previewClipStatus =
    currentPreviewTime < startTime
      ? `当前预览点在片段前 ${formatSignedOffsetLabel(currentPreviewTime - startTime)}`
      : currentPreviewTime > endTime
        ? `当前预览点在片段后 ${formatSignedOffsetLabel(currentPreviewTime - endTime)}`
        : "当前预览点在片段内";
  const currentPreviewPercent = videoInfo && videoInfo.duration > 0 ? (currentPreviewTime / videoInfo.duration) * 100 : 0;
  const currentPreviewIndicatorPercent = clamp(currentPreviewPercent, 2, 98);
  const hoverTimelinePercent = videoInfo && videoInfo.duration > 0 && hoverTimelineTime !== null ? (hoverTimelineTime / videoInfo.duration) * 100 : null;
  const hoverTimelineIndicatorPercent = hoverTimelinePercent === null ? null : clamp(hoverTimelinePercent, 2, 98);
  const hoverTimelineFrameNumber = hoverTimelineTime === null ? null : getFrameNumber(hoverTimelineTime, videoInfo);
  const showHoverTimelineIndicator =
    hoverTimelineIndicatorPercent !== null && Math.abs(hoverTimelineIndicatorPercent - currentPreviewIndicatorPercent) >= 3;
  const timelineStartPercent = videoInfo && videoInfo.duration > 0 ? (startTime / videoInfo.duration) * 100 : 0;
  const timelineEndPercent = videoInfo && videoInfo.duration > 0 ? (endTime / videoInfo.duration) * 100 : 0;
  const timelineStartIndicatorPercent = clamp(timelineStartPercent, 2, 98);
  const timelineEndIndicatorPercent = clamp(timelineEndPercent, 2, 98);
  const controlUnavailableReason =
    processing
      ? "处理中：更换视频、时间轴拖拽、设点、微调、重试与模式切换已锁定。"
      : previewStrategy !== "video"
        ? "当前为静态预览：播放片段与循环片段不可用，其余定位和导出仍可继续。"
        : !previewReady
          ? "视频预览尚未就绪：播放片段与循环片段暂不可用。"
          : !currentPreviewInClip
            ? "当前预览点在片段外：“回片段”可一键跳回最近边界。"
            : null;
  const controlUnavailableBadge =
    processing
      ? { tone: "warning" as const, label: "编辑已锁定" }
      : previewStrategy !== "video"
        ? { tone: "warning" as const, label: "静态预览" }
        : !previewReady
          ? { tone: "info" as const, label: "预览未就绪" }
          : !currentPreviewInClip
            ? { tone: "info" as const, label: "预览点在片段外" }
            : null;
  const exportUnavailableReason =
    processing
      ? "处理中：请等待当前任务结束"
      : clipDuration <= 0
        ? "当前片段长度无效"
        : null;
  const primaryActionLabel =
    processing
      ? "处理中…"
      : clipDuration <= 0
        ? "先设定片段"
        : "开始截取";
  const playClipButtonLabel =
    processing
      ? "处理中"
      : previewStrategy !== "video"
        ? "静态预览"
        : !previewReady
          ? "等待就绪"
          : clipPlaybackActive
            ? "暂停片段"
            : "播放片段";
  const loopClipButtonLabel =
    processing
      ? "处理中"
      : previewStrategy !== "video"
        ? "静态预览"
        : !previewReady
          ? "等待就绪"
          : "循环片段";
  const snapPreviewButtonLabel = currentPreviewInClip ? "已在片段内" : "回片段";
  const playClipButtonTitle =
    processing
      ? "处理中：播放片段暂不可用"
      : previewStrategy !== "video"
        ? "当前为静态预览：播放片段不可用"
        : !previewReady
          ? "视频预览尚未就绪"
          : "空格";
  const loopClipButtonTitle =
    processing
      ? "处理中：循环片段暂不可用"
      : previewStrategy !== "video"
        ? "当前为静态预览：循环片段不可用"
        : !previewReady
          ? "视频预览尚未就绪"
          : "R";
  const snapPreviewButtonTitle =
    processing ? "处理中：回片段暂不可用" : currentPreviewInClip ? "当前预览点已在片段内" : "B";
  const timelineStatusLabel =
    timelineDragMode === "start" ? "正在调整开始时间" :
    timelineDragMode === "end" ? "正在调整结束时间" :
    timelineDragMode === "playhead" ? "正在调整预览游标" :
    "拖动两端调整范围，点击时间轴切换预览帧，滚轮逐帧微调，Shift+滚轮按秒移动。";

  return {
    clipDuration,
    timelineFrameTargetCount,
    currentPreviewFrameNumber,
    startFrameNumber,
    endFrameNumber,
    clipFrameCount,
    currentPreviewInClip,
    offsetFromStart,
    offsetToEnd,
    clipProgressPercent,
    previewClipStatus,
    currentPreviewPercent,
    currentPreviewIndicatorPercent,
    hoverTimelineIndicatorPercent,
    hoverTimelineFrameNumber,
    showHoverTimelineIndicator,
    timelineStartPercent,
    timelineEndPercent,
    timelineStartIndicatorPercent,
    timelineEndIndicatorPercent,
    controlUnavailableReason,
    controlUnavailableBadge,
    exportUnavailableReason,
    primaryActionLabel,
    playClipButtonLabel,
    loopClipButtonLabel,
    snapPreviewButtonLabel,
    playClipButtonTitle,
    loopClipButtonTitle,
    snapPreviewButtonTitle,
    timelineStatusLabel,
  };
}
