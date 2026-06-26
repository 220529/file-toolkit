import { describe, expect, it, vi } from "vitest";
import type { BrushStroke, ImageInfo, WatermarkBatchProgress } from "../../api/tauri";
import { buildWatermarkSmartTips } from "./smartTips";
import {
  clamp,
  clampRectToImage,
  flattenBrushGestures,
  getBatchProgressText,
  getBrushDiameter,
  getCornerWatermarkRect,
  getDefaultRect,
  getPreviewImageSrc,
  splitBrushGestures,
} from "./utils";
import { getWatermarkViewState } from "./viewState";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
}));

const image: ImageInfo = {
  width: 1000,
  height: 500,
  path: "/tmp/source.png",
  thumbnail: "",
};

describe("watermark utils", () => {
  it("clamps values and selections inside the image", () => {
    expect(clamp(12, 0, 10)).toBe(10);
    expect(clamp(-2, 0, 10)).toBe(0);
    expect(clamp(5, 0, 10)).toBe(5);

    expect(
      clampRectToImage(
        {
          x: 995,
          y: -3,
          w: 4,
          h: 800,
        },
        {
          ...image,
          width: 100,
          height: 80,
        }
      )
    ).toEqual({ x: 92, y: 0, w: 8, h: 80 });
  });

  it("places the default watermark rectangle near the lower-right corner", () => {
    expect(getCornerWatermarkRect(image)).toEqual({
      x: 755,
      y: 426,
      w: 220,
      h: 56,
    });
    expect(getDefaultRect(image)).toEqual(getCornerWatermarkRect(image));
  });

  it("splits and flattens brush strokes by gesture starts", () => {
    const strokes: BrushStroke[] = [
      { x: 1, y: 1, size: 8, erase: false, start: false },
      { x: 2, y: 2, size: 8, erase: false, start: false },
      { x: 10, y: 10, size: 12, erase: false, start: true },
      { x: 11, y: 11, size: 12, erase: false, start: false },
      { x: 20, y: 20, size: 10, erase: true, start: true },
    ];

    const gestures = splitBrushGestures(strokes);

    expect(gestures).toHaveLength(3);
    expect(gestures.map((gesture) => gesture.length)).toEqual([2, 2, 1]);
    expect(flattenBrushGestures(gestures)).toEqual(strokes);
  });

  it("builds preview URLs, brush diameters, and batch progress text", () => {
    expect(getPreviewImageSrc({ ...image, thumbnail: "thumb://ready" })).toBe("thumb://ready");
    expect(getPreviewImageSrc(image)).toBe("asset:///tmp/source.png");

    expect(getBrushDiameter({ x: 0, y: 0, size: 0, erase: false, start: true }, 24)).toBe(24);
    expect(getBrushDiameter({ x: 0, y: 0, size: -5, erase: false, start: true }, 24)).toBe(1);

    expect(getBatchProgressText(null, "准备中")).toBe("准备中");

    const progress: WatermarkBatchProgress = {
      task_id: "wm-1",
      stage: "processing",
      current: 3,
      total: 5,
      percent: 60,
      current_file: "photo.png",
      succeeded: 2,
      failed: 1,
    };

    expect(getBatchProgressText(progress, "准备中")).toBe("已完成 3 / 5 · 2 成功 · 1 失败 · photo.png");
  });
});

describe("getWatermarkViewState", () => {
  it("derives simple repair precision warnings and primary action state", () => {
    const state = getWatermarkViewState({
      imageWidth: 1000,
      imageHeight: 1000,
      rect: { x: 0, y: 0, w: 300, h: 300 },
      removeMode: "repair",
      simpleMode: true,
      activeRepairTool: "rect",
      activeRepairMaskBase: "rect",
      brushGestureCount: 2,
      processing: false,
    });

    expect(state.canvasHint).toContain("基础修复");
    expect(state.magnifierZoom).toBe("4.4");
    expect(state.selectionAreaRatio).toBe(0.09);
    expect(state.simpleRepairNeedsPrecision).toBe(true);
    expect(state.selectionAreaPercent).toBe("9.0");
    expect(state.manualStrokeCount).toBe(2);
    expect(state.primaryActionLabel).toBe("当前范围偏大，先切到高级精修");
  });

  it("prioritizes processing state and handles non-repair modes", () => {
    expect(
      getWatermarkViewState({
        imageWidth: 1000,
        imageHeight: 1000,
        rect: { x: 0, y: 0, w: 50, h: 50 },
        removeMode: "repair",
        simpleMode: false,
        activeRepairTool: "brush",
        activeRepairMaskBase: "blank",
        brushGestureCount: 0,
        processing: true,
      }).primaryActionLabel
    ).toBe("处理中…");

    const fillState = getWatermarkViewState({
      imageWidth: 1000,
      imageHeight: 1000,
      rect: { x: 0, y: 0, w: 50, h: 50 },
      removeMode: "fill",
      simpleMode: false,
      activeRepairTool: "rect",
      activeRepairMaskBase: "rect",
      brushGestureCount: 0,
      processing: false,
    });

    expect(fillState.canvasHint).toContain("颜色覆盖模式");
    expect(fillState.primaryActionLabel).toBe("应用处理");
  });
});

describe("buildWatermarkSmartTips", () => {
  const actions = {
    openAdvancedMode: vi.fn(),
    switchToPreciseRepair: vi.fn(),
    switchToBrush: vi.fn(),
    switchToErase: vi.fn(),
    switchToBlankBrush: vi.fn(),
    continueRefine: vi.fn(),
    switchToRepairMode: vi.fn(),
  };

  it("promotes precision first when simple repair selection is too large", () => {
    const tips = buildWatermarkSmartTips({
      removeMode: "repair",
      simpleMode: true,
      activeRepairTool: "rect",
      activeRepairMaskBase: "rect",
      simpleRepairNeedsPrecision: true,
      selectionAreaPercent: "9.0",
      selectionAreaRatio: 0.09,
      manualStrokeCount: 0,
      hasResult: false,
      actions,
    });

    expect(tips.map((tip) => tip.title)).toEqual(["当前选区偏大，直接修复会更容易发糊", "当前是简洁模式"]);
    expect(tips[0].primaryAction?.label).toBe("切到精修");
    expect(tips[1].primaryAction?.label).toBe("打开高级模式");
  });

  it("warns about advanced repair setups that need a more precise mask", () => {
    expect(
      buildWatermarkSmartTips({
        removeMode: "repair",
        simpleMode: false,
        activeRepairTool: "brush",
        activeRepairMaskBase: "blank",
        simpleRepairNeedsPrecision: false,
        selectionAreaPercent: "1.0",
        selectionAreaRatio: 0.01,
        manualStrokeCount: 0,
        hasResult: false,
        actions,
      })[0].title
    ).toBe("空蒙版还没有修复区域");

    expect(
      buildWatermarkSmartTips({
        removeMode: "repair",
        simpleMode: false,
        activeRepairTool: "rect",
        activeRepairMaskBase: "rect",
        simpleRepairNeedsPrecision: false,
        selectionAreaPercent: "13.0",
        selectionAreaRatio: 0.13,
        manualStrokeCount: 0,
        hasResult: false,
        actions,
      })[0].primaryAction?.label
    ).toBe("改为空蒙版");
  });

  it("suggests refinement actions after manual strokes or generated results", () => {
    const tips = buildWatermarkSmartTips({
      removeMode: "repair",
      simpleMode: false,
      activeRepairTool: "rect",
      activeRepairMaskBase: "rect",
      simpleRepairNeedsPrecision: false,
      selectionAreaPercent: "1.0",
      selectionAreaRatio: 0.01,
      manualStrokeCount: 2,
      hasResult: true,
      actions,
    });

    expect(tips.map((tip) => tip.title)).toEqual(["已经进入精修阶段", "结果图可以直接继续精修"]);
    expect(tips[0].secondaryAction?.label).toBe("切到擦除");
    expect(tips[1].tone).toBe("success");
  });

  it("warns when fill or blur selections are too large", () => {
    expect(
      buildWatermarkSmartTips({
        removeMode: "fill",
        simpleMode: false,
        activeRepairTool: "rect",
        activeRepairMaskBase: "rect",
        simpleRepairNeedsPrecision: false,
        selectionAreaPercent: "9.0",
        selectionAreaRatio: 0.09,
        manualStrokeCount: 0,
        hasResult: false,
        actions,
      })[0].title
    ).toBe("填色区域偏大");

    expect(
      buildWatermarkSmartTips({
        removeMode: "blur",
        simpleMode: false,
        activeRepairTool: "rect",
        activeRepairMaskBase: "rect",
        simpleRepairNeedsPrecision: false,
        selectionAreaPercent: "13.0",
        selectionAreaRatio: 0.13,
        manualStrokeCount: 0,
        hasResult: false,
        actions,
      })[0].title
    ).toBe("模糊范围偏大");
  });
});
