import { describe, expect, it } from "vitest";
import type { VideoInfo } from "../../api/tauri";
import {
  ensureOutputPathExtension,
  formatFps,
  formatSignedOffsetLabel,
  formatTime,
  formatTimeForFilename,
  getClipFrameCount,
  getFrameDuration,
  getFrameNumber,
  getMinClipDuration,
  getPreferredPreciseOutputExtension,
  getPreferredPreviewStrategy,
  getTimelineFrameCount,
  isSupportedPreciseOutputExtension,
  parseTimeInput,
  snapTimeToFrame,
} from "./utils";
import { getVideoCutViewState } from "./viewState";

const videoInfo: VideoInfo = {
  duration: 100,
  width: 1920,
  height: 1080,
  fps: 25,
};

const timeInputCases: Array<[string, number | null]> = [
  ["3.75", 3.75],
  ["01:02.25", 62.25],
  ["1:02:03.5", 3723.5],
  ["", null],
  ["1::2", null],
  ["-1", null],
  ["abc", null],
];

describe("videoCut utils", () => {
  describe("time formatting and parsing", () => {
    it("formats seconds for display and filenames", () => {
      expect(formatTime(-1)).toBe("0:00.000");
      expect(formatTime(65.4326)).toBe("1:05.433");
      expect(formatTime(3661.004)).toBe("1:01:01.004");

      expect(formatTimeForFilename(65.4326)).toBe("01m05s433ms");
      expect(formatTimeForFilename(3661.004)).toBe("01h01m01s004ms");
      expect(formatSignedOffsetLabel(2.5)).toBe("+0:02.500");
      expect(formatSignedOffsetLabel(-2.5)).toBe("-0:02.500");
    });

    it.each(timeInputCases)("parses %j as %j", (input, expected) => {
      expect(parseTimeInput(input)).toBe(expected);
    });
  });

  describe("frame calculations", () => {
    it("uses a safe frame duration and clip duration", () => {
      expect(getFrameDuration(25)).toBeCloseTo(0.04);
      expect(getFrameDuration(0)).toBeCloseTo(1 / 30);
      expect(getFrameDuration(240)).toBeCloseTo(1 / 120);
      expect(getMinClipDuration(10, 25)).toBeCloseTo(0.04);
      expect(getMinClipDuration(0, 25)).toBe(0);
    });

    it("maps times to frames and frame counts", () => {
      expect(getFrameNumber(0, videoInfo)).toBe(1);
      expect(getFrameNumber(1, videoInfo)).toBe(26);
      expect(getFrameNumber(1, null)).toBe(0);
      expect(getClipFrameCount(10, 20, videoInfo)).toBe(250);
      expect(getClipFrameCount(10, 20, null)).toBe(0);
    });

    it("snaps times to frame boundaries", () => {
      expect(snapTimeToFrame(-2, videoInfo)).toBe(0);
      expect(snapTimeToFrame(200, videoInfo)).toBe(100);
      expect(snapTimeToFrame(1.021, videoInfo)).toBeCloseTo(1.04);
      expect(snapTimeToFrame(1.039, videoInfo, "floor")).toBeCloseTo(1);
      expect(snapTimeToFrame(1.001, videoInfo, "ceil")).toBeCloseTo(1.04);
      expect(snapTimeToFrame(1.25, null)).toBe(1.25);
    });
  });

  describe("output and preview helpers", () => {
    it("formats fps and timeline frame counts", () => {
      expect(formatFps(29.97)).toBe("29.97");
      expect(formatFps(30)).toBe("30");
      expect(formatFps(0)).toBe("30");
      expect(getTimelineFrameCount(20, 0)).toBe(8);
      expect(getTimelineFrameCount(60, 184)).toBe(10);
      expect(getTimelineFrameCount(60, 3000)).toBe(24);
    });

    it("chooses preview and output extensions", () => {
      expect(getPreferredPreviewStrategy("/tmp/movie.MP4")).toBe("video");
      expect(getPreferredPreviewStrategy("/tmp/movie.avi")).toBe("image");
      expect(getPreferredPreciseOutputExtension("MOV")).toBe("mov");
      expect(getPreferredPreciseOutputExtension("webm")).toBe("mp4");
      expect(isSupportedPreciseOutputExtension("mkv")).toBe(true);
      expect(isSupportedPreciseOutputExtension("webm")).toBe(false);
      expect(ensureOutputPathExtension("/tmp/clip", "mp4")).toBe("/tmp/clip.mp4");
      expect(ensureOutputPathExtension("/tmp/clip.mov", "mp4")).toBe("/tmp/clip.mov");
    });
  });
});

describe("getVideoCutViewState", () => {
  function buildState(overrides: Partial<Parameters<typeof getVideoCutViewState>[0]> = {}) {
    return getVideoCutViewState({
      videoInfo,
      startTime: 10,
      endTime: 20,
      currentPreviewTime: 15,
      hoverTimelineTime: 30,
      timelineWidth: 920,
      timelineDragMode: null,
      processing: false,
      previewStrategy: "video",
      previewReady: true,
      clipPlaybackActive: false,
      ...overrides,
    });
  }

  it("derives clip, frame, timeline, and action state for an active video preview", () => {
    const state = buildState();

    expect(state.clipDuration).toBe(10);
    expect(state.timelineFrameTargetCount).toBe(10);
    expect(state.currentPreviewFrameNumber).toBe(376);
    expect(state.startFrameNumber).toBe(251);
    expect(state.endFrameNumber).toBe(501);
    expect(state.clipFrameCount).toBe(250);
    expect(state.currentPreviewInClip).toBe(true);
    expect(state.offsetFromStart).toBe(5);
    expect(state.offsetToEnd).toBe(5);
    expect(state.clipProgressPercent).toBe(50);
    expect(state.previewClipStatus).toBe("当前预览点在片段内");
    expect(state.currentPreviewPercent).toBe(15);
    expect(state.currentPreviewIndicatorPercent).toBe(15);
    expect(state.hoverTimelineIndicatorPercent).toBe(30);
    expect(state.hoverTimelineFrameNumber).toBe(751);
    expect(state.showHoverTimelineIndicator).toBe(true);
    expect(state.timelineStartIndicatorPercent).toBe(10);
    expect(state.timelineEndIndicatorPercent).toBe(20);
    expect(state.controlUnavailableReason).toBeNull();
    expect(state.controlUnavailableBadge).toBeNull();
    expect(state.exportUnavailableReason).toBeNull();
    expect(state.primaryActionLabel).toBe("开始截取");
    expect(state.playClipButtonLabel).toBe("播放片段");
    expect(state.loopClipButtonLabel).toBe("循环片段");
    expect(state.snapPreviewButtonLabel).toBe("已在片段内");
  });

  it("explains unavailable controls for processing, static previews, and out-of-clip previews", () => {
    expect(buildState({ processing: true }).controlUnavailableBadge).toEqual({
      tone: "warning",
      label: "编辑已锁定",
    });
    expect(buildState({ processing: true }).primaryActionLabel).toBe("处理中…");

    const staticPreview = buildState({ previewStrategy: "image" });
    expect(staticPreview.controlUnavailableBadge).toEqual({ tone: "warning", label: "静态预览" });
    expect(staticPreview.playClipButtonLabel).toBe("静态预览");

    const waitingPreview = buildState({ previewReady: false });
    expect(waitingPreview.controlUnavailableBadge).toEqual({ tone: "info", label: "预览未就绪" });
    expect(waitingPreview.loopClipButtonLabel).toBe("等待就绪");

    const outsideClip = buildState({ currentPreviewTime: 25, hoverTimelineTime: null });
    expect(outsideClip.currentPreviewInClip).toBe(false);
    expect(outsideClip.previewClipStatus).toBe("当前预览点在片段后 +0:05.000");
    expect(outsideClip.controlUnavailableBadge).toEqual({ tone: "info", label: "预览点在片段外" });
    expect(outsideClip.snapPreviewButtonLabel).toBe("回片段");
    expect(outsideClip.hoverTimelineIndicatorPercent).toBeNull();
  });

  it("reports invalid clips and timeline drag status", () => {
    const state = buildState({
      startTime: 20,
      endTime: 20,
      currentPreviewTime: 20,
      timelineDragMode: "end",
    });

    expect(state.clipDuration).toBe(0);
    expect(state.exportUnavailableReason).toBe("当前片段长度无效");
    expect(state.primaryActionLabel).toBe("先设定片段");
    expect(state.clipProgressPercent).toBeNull();
    expect(state.timelineStatusLabel).toBe("正在调整结束时间");
  });
});
