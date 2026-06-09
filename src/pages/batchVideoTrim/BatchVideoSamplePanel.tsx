import type { RefObject, SyntheticEvent } from "react";
import type { VideoInfo } from "../../api/tauri";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import {
  formatTime,
  snapTimeToFrame,
  type PreviewStrategy,
} from "./utils";

export function BatchVideoSamplePanel({
  currentPreviewTime,
  filesCount,
  loadingSample,
  loadingTimeline,
  onJumpToTrimPoint,
  onPreviewError,
  onPreviewLoadedMetadata,
  onPreviewTimeUpdate,
  onResetTrimPoint,
  onSelectNextSample,
  onSelectPreviousSample,
  onSelectRandomSample,
  onSetTrimToCurrentFrame,
  onStepFrame,
  onSyncPreviewTime,
  previewFrame,
  previewFrameError,
  previewReady,
  previewStrategy,
  previewVideoRef,
  processing,
  reviewedCount,
  sampleIndex,
  sampleInfo,
  sampleKeptDuration,
  samplePath,
  sampleVideoSrc,
  timelineFrames,
  trimTime,
}: {
  currentPreviewTime: number;
  filesCount: number;
  loadingSample: boolean;
  loadingTimeline: boolean;
  onJumpToTrimPoint: () => void;
  onPreviewError: () => void;
  onPreviewLoadedMetadata: (event: SyntheticEvent<HTMLVideoElement>) => void;
  onPreviewTimeUpdate: (event: SyntheticEvent<HTMLVideoElement>) => void;
  onResetTrimPoint: () => void;
  onSelectNextSample: () => void;
  onSelectPreviousSample: () => void;
  onSelectRandomSample: () => void;
  onSetTrimToCurrentFrame: () => void;
  onStepFrame: (direction: -1 | 1) => void;
  onSyncPreviewTime: (time: number) => void;
  previewFrame: string;
  previewFrameError: boolean;
  previewReady: boolean;
  previewStrategy: PreviewStrategy;
  previewVideoRef: RefObject<HTMLVideoElement | null>;
  processing: boolean;
  reviewedCount: number;
  sampleIndex: number;
  sampleInfo: VideoInfo | null;
  sampleKeptDuration: number;
  samplePath: string;
  sampleVideoSrc: string;
  timelineFrames: string[];
  trimTime: number;
}) {
  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <div>
          <CardTitle>样本定点</CardTitle>
          <div className="mt-1 text-sm text-slate-500">
            只需要在一条样本上设定“片头结束点”，系统会应用到整批视频。
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone="default">样本 {sampleIndex >= 0 ? `${sampleIndex + 1}/${filesCount}` : "--"}</Badge>
          <Badge tone={reviewedCount >= 3 ? "success" : "default"}>抽查 {reviewedCount}</Badge>
          <Button variant="ghost" size="sm" onClick={onSelectPreviousSample} disabled={processing || sampleIndex <= 0}>
            上一条
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onSelectNextSample}
            disabled={processing || sampleIndex < 0 || sampleIndex >= filesCount - 1}
          >
            下一条
          </Button>
          <Button variant="ghost" size="sm" onClick={onSelectRandomSample} disabled={processing || filesCount <= 1}>
            随机抽查
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="overflow-hidden rounded-[24px] bg-slate-950">
          <div className="relative flex min-h-[320px] items-center justify-center px-4 py-4">
            {previewStrategy === "video" && sampleVideoSrc ? (
              <video
                key={sampleVideoSrc}
                ref={previewVideoRef}
                src={sampleVideoSrc}
                controls
                playsInline
                preload="metadata"
                className="max-h-[400px] w-full object-contain"
                onLoadedMetadata={onPreviewLoadedMetadata}
                onTimeUpdate={onPreviewTimeUpdate}
                onSeeked={onPreviewTimeUpdate}
                onError={onPreviewError}
              />
            ) : previewFrame ? (
              <img src={previewFrame} alt="样本预览" className="max-h-[400px] w-full object-contain" />
            ) : (
              <div className="text-sm text-slate-400">
                {previewFrameError ? "预览生成失败" : loadingSample ? "加载样本中…" : "等待载入样本"}
              </div>
            )}
            <div className="absolute bottom-4 left-4 rounded-full bg-slate-950/80 px-3 py-1 text-xs font-medium text-white">
              当前帧 {formatTime(currentPreviewTime)}
            </div>
            {previewStrategy === "video" && !previewReady && sampleVideoSrc && (
              <div className="absolute right-4 top-4 rounded-full bg-slate-950/72 px-3 py-1 text-xs text-white">
                载入预览中…
              </div>
            )}
            <div className="absolute bottom-4 right-4 rounded-full bg-[var(--brand-600)]/90 px-3 py-1 text-xs font-medium text-white">
              片头结束 {formatTime(trimTime)}
            </div>
          </div>
          <div className="border-t border-white/10 px-3 py-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div className="text-[11px] text-slate-400">
                {timelineFrames.length > 0 ? `缩略帧 ${timelineFrames.length} 张` : "缩略帧"}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2.5 text-[11px]"
                  onClick={() => onStepFrame(-1)}
                  disabled={processing || !sampleInfo}
                >
                  上一帧
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2.5 text-[11px]"
                  onClick={() => onStepFrame(1)}
                  disabled={processing || !sampleInfo}
                >
                  下一帧
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  className="h-7 px-2.5 text-[11px]"
                  onClick={onSetTrimToCurrentFrame}
                  disabled={processing || !sampleInfo}
                >
                  设为片头结束
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2.5 text-[11px]"
                  onClick={onJumpToTrimPoint}
                  disabled={processing || !sampleInfo || trimTime <= 0}
                >
                  看片头点
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2.5 text-[11px]"
                  onClick={onResetTrimPoint}
                  disabled={processing || trimTime <= 0}
                >
                  重置为 0
                </Button>
              </div>
            </div>
            {timelineFrames.length > 0 ? (
              <div className="flex gap-2 overflow-x-auto pb-1">
                {timelineFrames.map((frame, index) => {
                  const frameTime = sampleInfo
                    ? snapTimeToFrame((sampleInfo.duration / (timelineFrames.length + 1)) * (index + 1), sampleInfo)
                    : 0;
                  return (
                    <button
                      key={`${samplePath}-${index}`}
                      className="min-w-[92px] overflow-hidden rounded-xl border border-white/10 bg-slate-900/70 text-left transition hover:border-white/20"
                      disabled={processing}
                      onClick={() => onSyncPreviewTime(frameTime)}
                      title={formatTime(frameTime)}
                    >
                      <img src={frame} alt="" className="h-12 w-full object-cover" />
                      <div className="px-2 py-1 text-[10px] text-slate-300">{formatTime(frameTime)}</div>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-white/10 px-3 py-3 text-[11px] text-slate-400">
                {loadingTimeline ? "缩略帧生成中…" : "暂时没有缩略帧，可直接用视频播放器定位。"}
              </div>
            )}
          </div>
        </div>

        {sampleInfo && (
          <div className="space-y-3 rounded-[10px] border border-slate-200 bg-slate-50 px-4 py-3">
            <div className="flex h-2 overflow-hidden rounded-full bg-slate-200">
              <div
                className="bg-[var(--brand-500)]"
                style={{ width: `${sampleInfo.duration > 0 ? (trimTime / sampleInfo.duration) * 100 : 0}%` }}
              />
            </div>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
              <div className="flex items-center gap-2">
                <span className="text-slate-400">样本时长</span>
                <span className="font-medium text-slate-900">{formatTime(sampleInfo.duration)}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-slate-400">画面规格</span>
                <span className="font-medium text-slate-900">
                  {sampleInfo.width}×{sampleInfo.height}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-slate-400">帧率</span>
                <span className="font-medium text-slate-900">{sampleInfo.fps.toFixed(2).replace(/\.?0+$/, "")} fps</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-slate-400">删除前缀</span>
                <span className="font-medium text-slate-900">{formatTime(trimTime)}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-slate-400">样本保留</span>
                <span className="font-medium text-slate-900">{formatTime(sampleKeptDuration)}</span>
              </div>
              <div className="ml-auto text-[11px] text-slate-400">建议至少抽查 2 到 3 条样本后再开始批量处理。</div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
