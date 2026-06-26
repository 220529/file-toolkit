import { type PointerEvent as ReactPointerEvent, type RefObject, type SyntheticEvent, type WheelEvent as ReactWheelEvent } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { VideoInfo } from "../../api/tauri";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Switch } from "../../components/ui/switch";
import { cn } from "../../utils/cn";
import { getBaseName } from "../../utils/path";
import { formatTime, getFrameNumber, snapTimeToFrame } from "./utils";

type TimelineDragMode = "playhead" | "start" | "end";
type PreviewStrategy = "video" | "image";

interface VideoCutPreviewTimelineProps {
  videoPath: string;
  videoInfo: VideoInfo | null;
  previewStrategy: PreviewStrategy;
  previewFrame: string;
  timelineFrames: string[];
  loadingPreview: boolean;
  loadingTimelineFrames: boolean;
  previewFrameError: boolean;
  timelineFramesError: boolean;
  processing: boolean;
  preciseMode: boolean;
  previewReady: boolean;
  clipPlaybackActive: boolean;
  loopClipPlayback: boolean;
  showAdvancedControls: boolean;
  currentPreviewTime: number;
  startTime: number;
  endTime: number;
  clipDuration: number;
  timelineFrameTargetCount: number;
  currentPreviewFrameNumber: number;
  startFrameNumber: number;
  endFrameNumber: number;
  currentPreviewInClip: boolean;
  timelineStartPercent: number;
  timelineEndPercent: number;
  timelineStartIndicatorPercent: number;
  timelineEndIndicatorPercent: number;
  currentPreviewIndicatorPercent: number;
  hoverTimelineTime: number | null;
  hoverTimelineIndicatorPercent: number | null;
  hoverTimelineFrameNumber: number | null;
  showHoverTimelineIndicator: boolean;
  timelineDragMode: TimelineDragMode | null;
  controlUnavailableReason: string | null;
  controlUnavailableBadge: { tone: "info" | "warning"; label: string } | null;
  playClipButtonLabel: string;
  loopClipButtonLabel: string;
  snapPreviewButtonLabel: string;
  playClipButtonTitle: string;
  loopClipButtonTitle: string;
  snapPreviewButtonTitle: string;
  timelineStatusLabel: string;
  timelineRef: RefObject<HTMLDivElement | null>;
  previewVideoRef: RefObject<HTMLVideoElement | null>;
  onSelectVideo: () => void;
  onPreviewLoadedMetadata: (event: SyntheticEvent<HTMLVideoElement>) => void;
  onPreviewTimeUpdate: (event: SyntheticEvent<HTMLVideoElement>) => void;
  onPreviewPlay: () => void;
  onPreviewPause: () => void;
  onPreviewError: () => void;
  onRetryStaticPreview: () => void;
  onRetryTimelineFrames: () => void;
  onToggleClipPlayback: () => void;
  onLoopClipPlaybackChange: (checked: boolean) => void;
  onStepPreviewFrame: (direction: -1 | 1) => void;
  onApplyCurrentFrameToStart: () => void;
  onApplyCurrentFrameToEnd: () => void;
  onPreviewTimeChange: (time: number) => void;
  onSnapPreviewIntoClip: () => void;
  onPreviewClipMiddle: () => void;
  onShiftClipRange: (direction: -1 | 1) => void;
  onTimelinePointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onTimelinePointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onTimelinePointerLeave: () => void;
  onTimelineWheel: (event: ReactWheelEvent<HTMLDivElement>) => void;
  onTimelineHandlePointerDown: (mode: TimelineDragMode, event: ReactPointerEvent<HTMLButtonElement>) => void;
}

export function VideoCutPreviewTimeline({
  videoPath,
  videoInfo,
  previewStrategy,
  previewFrame,
  timelineFrames,
  loadingPreview,
  loadingTimelineFrames,
  previewFrameError,
  timelineFramesError,
  processing,
  preciseMode,
  previewReady,
  clipPlaybackActive,
  loopClipPlayback,
  showAdvancedControls,
  currentPreviewTime,
  startTime,
  endTime,
  clipDuration,
  timelineFrameTargetCount,
  currentPreviewFrameNumber,
  startFrameNumber,
  endFrameNumber,
  currentPreviewInClip,
  timelineStartPercent,
  timelineEndPercent,
  timelineStartIndicatorPercent,
  timelineEndIndicatorPercent,
  currentPreviewIndicatorPercent,
  hoverTimelineTime,
  hoverTimelineIndicatorPercent,
  hoverTimelineFrameNumber,
  showHoverTimelineIndicator,
  timelineDragMode,
  controlUnavailableReason,
  controlUnavailableBadge,
  playClipButtonLabel,
  loopClipButtonLabel,
  snapPreviewButtonLabel,
  playClipButtonTitle,
  loopClipButtonTitle,
  snapPreviewButtonTitle,
  timelineStatusLabel,
  timelineRef,
  previewVideoRef,
  onSelectVideo,
  onPreviewLoadedMetadata,
  onPreviewTimeUpdate,
  onPreviewPlay,
  onPreviewPause,
  onPreviewError,
  onRetryStaticPreview,
  onRetryTimelineFrames,
  onToggleClipPlayback,
  onLoopClipPlaybackChange,
  onStepPreviewFrame,
  onApplyCurrentFrameToStart,
  onApplyCurrentFrameToEnd,
  onPreviewTimeChange,
  onSnapPreviewIntoClip,
  onPreviewClipMiddle,
  onShiftClipRange,
  onTimelinePointerDown,
  onTimelinePointerMove,
  onTimelinePointerLeave,
  onTimelineWheel,
  onTimelineHandlePointerDown,
}: VideoCutPreviewTimelineProps) {
  const previewVideoSrc = videoPath ? convertFileSrc(videoPath) : "";

  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <div>
          <CardTitle>预览与时间轴</CardTitle>
          <div className="mt-1 text-sm text-slate-500">{getBaseName(videoPath)}</div>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone="info">{preciseMode ? "精确模式" : "快速模式"}</Badge>
          <Button variant="secondary" size="sm" onClick={onSelectVideo} disabled={processing}>
            更换视频
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="overflow-hidden rounded-[24px] bg-slate-950">
          <div className="relative flex min-h-[360px] items-center justify-center px-4 py-4">
            {previewStrategy === "video" && previewVideoSrc ? (
              <video
                key={previewVideoSrc}
                ref={previewVideoRef}
                src={previewVideoSrc}
                controls
                playsInline
                preload="metadata"
                className="max-h-[420px] w-full object-contain"
                onLoadedMetadata={onPreviewLoadedMetadata}
                onTimeUpdate={onPreviewTimeUpdate}
                onSeeked={onPreviewTimeUpdate}
                onPlay={onPreviewPlay}
                onPause={onPreviewPause}
                onError={onPreviewError}
              />
            ) : previewFrame ? (
              <img src={previewFrame} alt="视频预览" className="max-h-[420px] w-full object-contain" />
            ) : (
              <div className="text-sm text-slate-400">
                {previewFrameError ? "静态预览生成失败" : loadingPreview ? "加载预览中…" : "等待载入视频"}
              </div>
            )}
            <div className="absolute bottom-4 left-4 rounded-full bg-slate-950/80 px-3 py-1 text-xs font-medium text-white">
              {formatTime(currentPreviewTime)}
            </div>
            {previewStrategy === "video" && !previewReady && previewVideoSrc && (
              <div className="absolute right-4 top-4 rounded-full bg-slate-950/72 px-3 py-1 text-xs text-white">
                载入预览中…
              </div>
            )}
            {previewStrategy === "image" && (
              <div className="absolute right-4 top-4 rounded-full bg-slate-950/72 px-3 py-1 text-xs text-white">
                静态预览
              </div>
            )}
            {previewStrategy === "image" && loadingPreview && previewFrame && (
              <div className="absolute right-4 top-4 rounded-full bg-slate-950/72 px-3 py-1 text-xs text-white">
                更新中…
              </div>
            )}
            {previewStrategy === "image" && previewFrameError && (
              <div className="absolute right-4 bottom-4">
                <Button variant="secondary" size="sm" className="h-8 px-3 text-[11px]" onClick={onRetryStaticPreview} disabled={processing}>
                  重试预览
                </Button>
              </div>
            )}
            {processing && (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-slate-950/38 backdrop-blur-[1px]">
                <div className="rounded-full bg-slate-950/82 px-4 py-2 text-xs text-white">
                  处理中，已锁定预览编辑
                </div>
              </div>
            )}
          </div>

          {videoInfo && (
            <div className="border-t border-white/10 px-3 py-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div className="text-[11px] text-slate-400">
                  缩略帧
                  {timelineFrames.length > 0 ? ` ${timelineFrames.length}/${timelineFrameTargetCount}` : ""}
                </div>
                {controlUnavailableBadge && (
                  <Badge tone={controlUnavailableBadge.tone}>{controlUnavailableBadge.label}</Badge>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant={clipPlaybackActive ? "primary" : "ghost"}
                    size="sm"
                    className="h-7 px-2.5 text-[11px]"
                    onClick={onToggleClipPlayback}
                    disabled={processing || previewStrategy !== "video" || !previewReady || clipDuration <= 0}
                    aria-pressed={clipPlaybackActive}
                    title={playClipButtonTitle}
                  >
                    {playClipButtonLabel}
                  </Button>
                  <div className="flex items-center gap-2 rounded-full border border-white/10 bg-slate-900/50 px-2.5 py-1">
                    <span className="text-[11px] text-slate-300">{loopClipButtonLabel}</span>
                    <Switch
                      checked={loopClipPlayback}
                      onCheckedChange={onLoopClipPlaybackChange}
                      disabled={processing || previewStrategy !== "video" || !previewReady || clipDuration <= 0}
                      title={loopClipButtonTitle}
                      className="h-5 w-9"
                    />
                  </div>
                  <Button variant="ghost" size="sm" className="h-7 px-2.5 text-[11px]" onClick={() => onStepPreviewFrame(-1)} disabled={processing} title="左方向键">
                    上一帧
                  </Button>
                  <Button variant="ghost" size="sm" className="h-7 px-2.5 text-[11px]" onClick={() => onStepPreviewFrame(1)} disabled={processing} title="右方向键">
                    下一帧
                  </Button>
                  <Button variant="ghost" size="sm" className="h-7 px-2.5 text-[11px]" onClick={onApplyCurrentFrameToStart} disabled={processing} title="[ / I">
                    设起点
                  </Button>
                  <Button variant="ghost" size="sm" className="h-7 px-2.5 text-[11px]" onClick={onApplyCurrentFrameToEnd} disabled={processing} title="] / O">
                    设终点
                  </Button>
                </div>
              </div>
              {showAdvancedControls && (
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <Button variant="ghost" size="sm" className="h-7 px-2.5 text-[11px]" onClick={() => onPreviewTimeChange(startTime)} disabled={processing} title="Home">
                    看起点
                  </Button>
                  <Button variant="ghost" size="sm" className="h-7 px-2.5 text-[11px]" onClick={onSnapPreviewIntoClip} disabled={processing || currentPreviewInClip} title={snapPreviewButtonTitle}>
                    {snapPreviewButtonLabel}
                  </Button>
                  <Button variant="ghost" size="sm" className="h-7 px-2.5 text-[11px]" onClick={onPreviewClipMiddle} disabled={processing} title="M">
                    看中点
                  </Button>
                  <Button variant="ghost" size="sm" className="h-7 px-2.5 text-[11px]" onClick={() => onPreviewTimeChange(endTime)} disabled={processing} title="End">
                    看终点
                  </Button>
                  <Button variant="ghost" size="sm" className="h-7 px-2.5 text-[11px]" onClick={() => onShiftClipRange(-1)} disabled={processing} title=",">
                    左移片段
                  </Button>
                  <Button variant="ghost" size="sm" className="h-7 px-2.5 text-[11px]" onClick={() => onShiftClipRange(1)} disabled={processing} title=".">
                    右移片段
                  </Button>
                </div>
              )}
              {timelineFrames.length > 0 ? (
                <div className="flex gap-2 overflow-x-auto pb-1">
                  {timelineFrames.map((frame, index) => {
                    const rawFrameTime = (videoInfo.duration / (timelineFrames.length + 1)) * (index + 1);
                    const frameTime = snapTimeToFrame(rawFrameTime, videoInfo);
                    const activeFrame = Math.abs(frameTime - currentPreviewTime) <= videoInfo.duration / (timelineFrames.length + 1) / 2;
                    const frameNumber = getFrameNumber(frameTime, videoInfo);
                    return (
                      <button
                        key={index}
                        className={cn(
                          "group min-w-[92px] overflow-hidden rounded-xl border bg-slate-900/70 text-left transition",
                          activeFrame ? "border-amber-300/80 ring-1 ring-amber-300/40" : "border-white/10 hover:border-white/20"
                        )}
                        disabled={processing}
                        title={`${formatTime(frameTime)} · #${frameNumber}`}
                        onClick={() => {
                          onPreviewTimeChange(frameTime);
                        }}
                      >
                        <img src={frame} alt="" className="h-12 w-full object-cover transition group-hover:opacity-100" />
                        <div className="px-2 py-1 text-[10px] text-slate-300">{formatTime(frameTime)}</div>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="rounded-xl border border-dashed border-white/10 px-3 py-3 text-[11px] text-slate-400">
                  {loadingTimelineFrames ? "缩略帧生成中…" : "暂无缩略帧，也可以直接用下方时间轴和预览操作。"}
                </div>
              )}
              {controlUnavailableReason && (
                <div className="mt-2 rounded-xl border border-white/10 bg-slate-950/40 px-3 py-2 text-[11px] text-slate-300">
                  {controlUnavailableReason}
                </div>
              )}
            </div>
          )}
          {loadingTimelineFrames && (
            <div className="border-t border-white/10 px-3 py-3 text-[11px] text-slate-400">
              正在生成时间轴缩略帧…
            </div>
          )}
          {timelineFramesError && (
            <div className="border-t border-white/10 px-3 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-amber-200/90">
                <span>时间轴缩略帧生成失败，可继续拖动时间轴和预览后导出。</span>
                <Button variant="secondary" size="sm" className="h-7 px-2.5 text-[11px]" onClick={onRetryTimelineFrames} disabled={processing}>
                  重试缩略帧
                </Button>
              </div>
            </div>
          )}

          <div className="border-t border-white/10 px-3 py-3">
            <div className="mb-2 flex items-center justify-between text-[11px] text-slate-400">
              <span>{timelineStatusLabel}</span>
              <span>{formatTime(startTime)} - {formatTime(endTime)}</span>
            </div>
            <div
              ref={timelineRef}
              className={cn(
                "relative h-14 overflow-hidden rounded-[10px] border bg-[linear-gradient(180deg,rgba(15,23,42,0.82),rgba(30,41,59,0.92))] select-none touch-none transition",
                timelineDragMode ? "border-amber-300/40 ring-1 ring-amber-300/20" : "border-white/10"
              )}
              onPointerDown={onTimelinePointerDown}
              onPointerMove={onTimelinePointerMove}
              onPointerLeave={onTimelinePointerLeave}
              onWheel={onTimelineWheel}
            >
              <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(51,109,255,0.12),rgba(255,255,255,0.02),rgba(51,109,255,0.12))]" />

              <div className="absolute inset-y-0 left-0 bg-slate-950/60" style={{ width: `${timelineStartPercent}%` }} />
              <div className="absolute inset-y-0 right-0 bg-slate-950/60" style={{ width: `${100 - timelineEndPercent}%` }} />
              <div
                className="absolute inset-y-0 border-x border-[rgba(147,197,253,0.9)] bg-[rgba(59,130,246,0.22)]"
                style={{
                  left: `${timelineStartPercent}%`,
                  width: `${Math.max(0, timelineEndPercent - timelineStartPercent)}%`,
                }}
              />
              <div
                className="absolute inset-y-0 z-10 w-px -translate-x-1/2 bg-amber-300/90 shadow-[0_0_0_1px_rgba(253,224,71,0.14)]"
                style={{ left: `${currentPreviewIndicatorPercent}%` }}
              />
              {showHoverTimelineIndicator && !timelineDragMode && (
                <div
                  className="absolute inset-y-0 z-[9] w-px -translate-x-1/2 bg-sky-300/80 shadow-[0_0_0_1px_rgba(125,211,252,0.16)]"
                  style={{ left: `${hoverTimelineIndicatorPercent}%` }}
                />
              )}
              <div
                className="absolute -top-1 z-10 -translate-x-1/2 -translate-y-full rounded-full bg-slate-950/92 px-2 py-1 text-[10px] font-medium text-amber-100 shadow-[0_8px_18px_rgba(15,23,42,0.28)]"
                style={{ left: `${currentPreviewIndicatorPercent}%` }}
              >
                {formatTime(currentPreviewTime)} · #{currentPreviewFrameNumber}
              </div>
              {showHoverTimelineIndicator && hoverTimelineTime !== null && !timelineDragMode && (
                <div
                  className="absolute -top-1 z-[9] -translate-x-1/2 -translate-y-full rounded-full bg-sky-950/90 px-2 py-1 text-[10px] font-medium text-sky-100 shadow-[0_8px_18px_rgba(2,132,199,0.18)]"
                  style={{ left: `${hoverTimelineIndicatorPercent}%` }}
                >
                  {formatTime(hoverTimelineTime)}{hoverTimelineFrameNumber ? ` · #${hoverTimelineFrameNumber}` : ""}
                </div>
              )}
              {timelineDragMode === "start" && (
                <div
                  className="absolute -top-1 z-[11] -translate-x-1/2 -translate-y-full rounded-full bg-[var(--brand-600)]/92 px-2 py-1 text-[10px] font-medium text-white shadow-[0_8px_18px_rgba(37,99,235,0.22)]"
                  style={{ left: `${timelineStartIndicatorPercent}%` }}
                >
                  {formatTime(startTime)} · #{startFrameNumber}
                </div>
              )}
              {timelineDragMode === "end" && (
                <div
                  className="absolute -top-1 z-[11] -translate-x-1/2 -translate-y-full rounded-full bg-rose-500/92 px-2 py-1 text-[10px] font-medium text-white shadow-[0_8px_18px_rgba(244,63,94,0.22)]"
                  style={{ left: `${timelineEndIndicatorPercent}%` }}
                >
                  {formatTime(endTime)} · #{endFrameNumber}
                </div>
              )}

              <button
                className="absolute inset-y-0 z-20 w-6 -translate-x-1/2 cursor-ew-resize"
                style={{ left: `${timelineStartPercent}%` }}
                onPointerDown={(event) => onTimelineHandlePointerDown("start", event)}
                aria-label="调整开始时间"
                disabled={processing}
              >
                <span className="absolute left-1/2 top-1 h-4 w-2 -translate-x-1/2 bg-[var(--brand-500)] [clip-path:polygon(50%_100%,0_0,100%_0)] drop-shadow-[0_4px_8px_rgba(15,23,42,0.28)]" />
              </button>
              <button
                className="absolute inset-y-0 z-20 w-6 -translate-x-1/2 cursor-ew-resize"
                style={{ left: `${timelineEndPercent}%` }}
                onPointerDown={(event) => onTimelineHandlePointerDown("end", event)}
                aria-label="调整结束时间"
                disabled={processing}
              >
                <span className="absolute left-1/2 top-1 h-4 w-2 -translate-x-1/2 bg-rose-400 [clip-path:polygon(50%_100%,0_0,100%_0)] drop-shadow-[0_4px_8px_rgba(15,23,42,0.28)]" />
              </button>
            </div>
            <div className="mt-2 grid grid-cols-3 text-[11px] text-slate-400">
              <span>开始 {formatTime(startTime)} · #{startFrameNumber}</span>
              <span className="text-center">片段 {formatTime(clipDuration)}</span>
              <span className="text-right">结束 {formatTime(endTime)} · #{endFrameNumber}</span>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
