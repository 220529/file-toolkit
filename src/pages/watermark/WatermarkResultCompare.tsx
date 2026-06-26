import type { MouseEvent, RefObject } from "react";
import type { ImageInfo } from "../../api/tauri";
import { Badge } from "../../components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Slider } from "../../components/ui/slider";
import { COMPARE_MAGNIFIER_SAMPLE_SIZE, COMPARE_MAGNIFIER_SIZE } from "./constants";
import type { ComparePoint } from "./types";
import { getPreviewImageSrc } from "./utils";

interface WatermarkResultCompareProps {
  image: ImageInfo;
  resultPreview: ImageInfo | null;
  loadingResultPreview: boolean;
  compareSplit: number;
  compareHoverPoint: ComparePoint | null;
  compareOriginalMagnifierRef: RefObject<HTMLCanvasElement | null>;
  compareResultMagnifierRef: RefObject<HTMLCanvasElement | null>;
  onCompareMouseMove: (event: MouseEvent<HTMLDivElement>) => void;
  onCompareMouseLeave: () => void;
  onCompareSplitChange: (value: number) => void;
}

export function WatermarkResultCompare({
  image,
  resultPreview,
  loadingResultPreview,
  compareSplit,
  compareHoverPoint,
  compareOriginalMagnifierRef,
  compareResultMagnifierRef,
  onCompareMouseMove,
  onCompareMouseLeave,
  onCompareSplitChange,
}: WatermarkResultCompareProps) {
  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <div>
          <CardTitle>前后对比</CardTitle>
          <div className="mt-1 text-sm text-slate-500">使用结果缩略图对比处理前后，拖动滑杆查看差异。</div>
        </div>
        <Badge tone="info">{loadingResultPreview ? "生成中" : "已更新"}</Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        {loadingResultPreview || !resultPreview ? (
          <div className="flex min-h-[220px] items-center justify-center rounded-[24px] border border-slate-200 bg-slate-50 text-sm text-slate-500">
            正在生成对比预览…
          </div>
        ) : (
          <>
            <div className="rounded-[24px] border border-slate-200 bg-slate-100 p-4">
              <div
                className="relative mx-auto w-full max-w-[760px] overflow-hidden rounded-[20px] bg-slate-950/5 cursor-crosshair"
                style={{ aspectRatio: `${image.width} / ${image.height}` }}
                onMouseMove={onCompareMouseMove}
                onMouseLeave={onCompareMouseLeave}
              >
                <img src={getPreviewImageSrc(image)} alt="原图" className="absolute inset-0 h-full w-full object-contain" />
                <div className="absolute inset-y-0 left-0 overflow-hidden" style={{ width: `${compareSplit}%` }}>
                  <img src={getPreviewImageSrc(resultPreview)} alt="处理后" className="absolute inset-0 h-full w-full object-contain" />
                </div>
                <div className="absolute left-3 top-3 rounded-full bg-white/88 px-3 py-1 text-xs font-medium text-slate-700 shadow-[0_6px_16px_rgba(15,23,42,0.12)]">
                  原图
                </div>
                <div className="absolute right-3 top-3 rounded-full bg-slate-900/78 px-3 py-1 text-xs font-medium text-white shadow-[0_6px_16px_rgba(15,23,42,0.24)]">
                  处理后
                </div>
                <div className="pointer-events-none absolute inset-y-0 z-10" style={{ left: `calc(${compareSplit}% - 1px)` }}>
                  <div className="relative h-full w-0.5 bg-white shadow-[0_0_0_1px_rgba(15,23,42,0.08),0_0_18px_rgba(255,255,255,0.5)]">
                    <div className="absolute left-1/2 top-1/2 flex h-9 w-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-white/80 bg-white text-slate-700 shadow-[0_10px_30px_rgba(15,23,42,0.16)]">
                      ⇆
                    </div>
                  </div>
                </div>
                {compareHoverPoint && (
                  <div
                    className="pointer-events-none absolute z-20"
                    style={{
                      left: compareHoverPoint.x,
                      top: compareHoverPoint.y,
                      transform: "translate(-50%, -50%)",
                    }}
                  >
                    <div className="relative flex h-8 w-8 items-center justify-center rounded-full border border-white/85 bg-white/30 shadow-[0_8px_24px_rgba(15,23,42,0.14)] backdrop-blur-[1px]">
                      <div className="absolute inset-x-1 top-1/2 h-px -translate-y-1/2 bg-white/95" />
                      <div className="absolute inset-y-1 left-1/2 w-px -translate-x-1/2 bg-white/95" />
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
              <Slider min={0} max={100} value={compareSplit} onValueChange={onCompareSplitChange} />
              <Badge tone="default">处理后显示 {compareSplit}%</Badge>
            </div>

            <div className="rounded-[24px] border border-slate-200 bg-slate-50 px-4 py-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div className="text-sm font-medium text-slate-800">局部前后放大对比</div>
                <Badge tone="default">{(COMPARE_MAGNIFIER_SIZE / COMPARE_MAGNIFIER_SAMPLE_SIZE).toFixed(1)}x</Badge>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <div className="rounded-[10px] border border-slate-200 bg-white p-3">
                  <div className="mb-2 text-xs font-medium text-slate-500">原图局部</div>
                  {compareHoverPoint ? (
                    <canvas
                      ref={compareOriginalMagnifierRef}
                      className="mx-auto h-44 w-44 rounded-[10px] border border-slate-200 bg-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.85)]"
                    />
                  ) : (
                    <div className="mx-auto flex h-44 w-44 items-center justify-center rounded-[10px] border border-dashed border-slate-200 bg-slate-50 text-center text-xs leading-5 text-slate-400">
                      将鼠标移到上方对比图
                      <br />
                      查看原图局部
                    </div>
                  )}
                </div>
                <div className="rounded-[10px] border border-slate-200 bg-white p-3">
                  <div className="mb-2 text-xs font-medium text-slate-500">处理后局部</div>
                  {compareHoverPoint ? (
                    <canvas
                      ref={compareResultMagnifierRef}
                      className="mx-auto h-44 w-44 rounded-[10px] border border-slate-200 bg-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.85)]"
                    />
                  ) : (
                    <div className="mx-auto flex h-44 w-44 items-center justify-center rounded-[10px] border border-dashed border-slate-200 bg-slate-50 text-center text-xs leading-5 text-slate-400">
                      将鼠标移到上方对比图
                      <br />
                      查看修复后局部
                    </div>
                  )}
                </div>
              </div>
              <div className="mt-3 text-xs leading-5 text-slate-500">
                {compareHoverPoint
                  ? `当前检查位置 ${Math.round(compareHoverPoint.ox)}, ${Math.round(compareHoverPoint.oy)}`
                  : "适合检查修复边缘、细字笔画和颜色过渡。"}
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
