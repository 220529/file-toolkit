import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { generatePreviewFrame, generateTimelineFrames, type VideoInfo } from "../../api/tauri";
import { getTimelineFrameCount, snapTimeToFrame } from "./utils";

type PreviewStrategy = "video" | "image";

type UseVideoCutPreviewFramesOptions = {
  videoPath: string;
  videoInfo: VideoInfo | null;
  timelineWidth: number;
  videoPathRef: MutableRefObject<string>;
  videoInfoRef: MutableRefObject<VideoInfo | null>;
  currentPreviewTimeRef: MutableRefObject<number>;
  setCurrentPreviewTime: Dispatch<SetStateAction<number>>;
  ensureVideoPathAvailable: (path: string, actionLabel: string) => Promise<boolean>;
};

export function useVideoCutPreviewFrames({
  videoPath,
  videoInfo,
  timelineWidth,
  videoPathRef,
  videoInfoRef,
  currentPreviewTimeRef,
  setCurrentPreviewTime,
  ensureVideoPathAvailable,
}: UseVideoCutPreviewFramesOptions) {
  const [previewFrame, setPreviewFrame] = useState("");
  const [timelineFrames, setTimelineFrames] = useState<string[]>([]);
  const [previewFrameError, setPreviewFrameError] = useState(false);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [loadingTimelineFrames, setLoadingTimelineFrames] = useState(false);
  const [timelineFramesError, setTimelineFramesError] = useState(false);
  const previewRequestIdRef = useRef(0);
  const timelineRequestIdRef = useRef(0);
  const lastTimelineFrameCountRef = useRef(0);
  const timelineFramesCacheRef = useRef(new Map<string, string[]>());
  const previewFrameCacheRef = useRef(new Map<string, string>());
  const previewTimeoutRef = useRef<number | null>(null);
  const timelineLoadTimeoutRef = useRef<number | null>(null);
  const videoCacheKeyRef = useRef("");

  const clearPendingPreviewTimeout = useCallback(() => {
    if (previewTimeoutRef.current !== null) {
      window.clearTimeout(previewTimeoutRef.current);
      previewTimeoutRef.current = null;
    }
  }, []);

  const cancelPendingPreviewLoads = useCallback(() => {
    previewRequestIdRef.current += 1;
    timelineRequestIdRef.current += 1;
    clearPendingPreviewTimeout();
    if (timelineLoadTimeoutRef.current !== null) {
      window.clearTimeout(timelineLoadTimeoutRef.current);
      timelineLoadTimeoutRef.current = null;
    }
  }, [clearPendingPreviewTimeout]);

  const setVideoCacheKey = useCallback((cacheKey: string) => {
    videoCacheKeyRef.current = cacheKey;
  }, []);

  const preparePreviewFramesForVideoLoad = useCallback((preferredStrategy: PreviewStrategy) => {
    cancelPendingPreviewLoads();
    setPreviewFrame("");
    setPreviewFrameError(false);
    setLoadingPreview(preferredStrategy === "image");
    setLoadingTimelineFrames(true);
    setTimelineFramesError(false);
    lastTimelineFrameCountRef.current = 0;
  }, [cancelPendingPreviewLoads]);

  const clearTimelineFrames = useCallback(() => {
    setTimelineFrames([]);
  }, []);

  const resetPreviewFramesAfterVideoLoadFailure = useCallback(() => {
    setPreviewFrame("");
    setTimelineFrames([]);
    setLoadingPreview(false);
    setLoadingTimelineFrames(false);
    setTimelineFramesError(false);
    setPreviewFrameError(false);
  }, []);

  const clearPreviewFrameErrors = useCallback(() => {
    setPreviewFrameError(false);
    setTimelineFramesError(false);
  }, []);

  const loadPreviewFrame = useCallback(async (path: string, time: number) => {
    const info = videoInfoRef.current;
    const snappedTime = info ? snapTimeToFrame(time, info) : time;
    const cacheKey = `${videoCacheKeyRef.current || path}::${snappedTime.toFixed(6)}`;
    const cachedFrame = previewFrameCacheRef.current.get(cacheKey);
    if (cachedFrame) {
      setPreviewFrame(cachedFrame);
      setPreviewFrameError(false);
      setCurrentPreviewTime(snappedTime);
      setLoadingPreview(false);
      return;
    }

    const requestId = ++previewRequestIdRef.current;
    setLoadingPreview(true);
    setPreviewFrameError(false);
    try {
      const frame = await generatePreviewFrame(path, snappedTime);
      if (previewRequestIdRef.current !== requestId) return;
      setPreviewFrame(frame);
      setPreviewFrameError(false);
      setCurrentPreviewTime(snappedTime);
      previewFrameCacheRef.current.set(cacheKey, frame);
      if (previewFrameCacheRef.current.size > 36) {
        const oldestKey = previewFrameCacheRef.current.keys().next().value;
        if (oldestKey) {
          previewFrameCacheRef.current.delete(oldestKey);
        }
      }
    } catch (e) {
      if (previewRequestIdRef.current !== requestId) return;
      console.error("生成预览帧失败:", e);
      setPreviewFrameError(true);
    } finally {
      if (previewRequestIdRef.current === requestId) {
        setLoadingPreview(false);
      }
    }
  }, [setCurrentPreviewTime, videoInfoRef]);

  const loadTimelineFrames = useCallback(async (path: string, count: number) => {
    const requestId = ++timelineRequestIdRef.current;
    const cacheKey = `${videoCacheKeyRef.current || path}::${count}`;
    const cachedFrames = timelineFramesCacheRef.current.get(cacheKey);
    if (cachedFrames) {
      setTimelineFrames(cachedFrames);
      setLoadingTimelineFrames(false);
      setTimelineFramesError(false);
      return;
    }

    setLoadingTimelineFrames(true);
    setTimelineFramesError(false);
    try {
      const frames = await generateTimelineFrames(path, count);
      if (timelineRequestIdRef.current !== requestId) return;
      setTimelineFrames(frames);
      timelineFramesCacheRef.current.set(cacheKey, frames);
      if (timelineFramesCacheRef.current.size > 12) {
        const oldestKey = timelineFramesCacheRef.current.keys().next().value;
        if (oldestKey) {
          timelineFramesCacheRef.current.delete(oldestKey);
        }
      }
    } catch (e) {
      if (timelineRequestIdRef.current !== requestId) return;
      console.error("生成时间轴失败:", e);
      setTimelineFramesError(true);
    } finally {
      if (timelineRequestIdRef.current === requestId) {
        setLoadingTimelineFrames(false);
      }
    }
  }, []);

  const updatePreviewFrameDebounced = useCallback((time: number) => {
    clearPendingPreviewTimeout();
    previewTimeoutRef.current = window.setTimeout(() => {
      previewTimeoutRef.current = null;
      const path = videoPathRef.current;
      if (path) {
        void loadPreviewFrame(path, time);
      }
    }, 120);
  }, [clearPendingPreviewTimeout, loadPreviewFrame, videoPathRef]);

  const retryStaticPreview = useCallback(() => {
    const path = videoPathRef.current;
    if (!path) return;
    void (async () => {
      if (!(await ensureVideoPathAvailable(path, "重试预览"))) return;
      await loadPreviewFrame(path, currentPreviewTimeRef.current);
    })();
  }, [currentPreviewTimeRef, ensureVideoPathAvailable, loadPreviewFrame, videoPathRef]);

  const retryTimelineFrames = useCallback(() => {
    const path = videoPathRef.current;
    const info = videoInfoRef.current;
    if (!path || !info) return;
    const count = getTimelineFrameCount(info.duration, timelineWidth);
    lastTimelineFrameCountRef.current = count;
    void (async () => {
      if (!(await ensureVideoPathAvailable(path, "重试缩略帧"))) return;
      await loadTimelineFrames(path, count);
    })();
  }, [ensureVideoPathAvailable, loadTimelineFrames, timelineWidth, videoInfoRef, videoPathRef]);

  useEffect(() => {
    if (!videoPath || !videoInfo) return;

    const count = getTimelineFrameCount(videoInfo.duration, timelineWidth);
    if (count === lastTimelineFrameCountRef.current && timelineFrames.length > 0) return;

    if (timelineLoadTimeoutRef.current !== null) {
      window.clearTimeout(timelineLoadTimeoutRef.current);
    }

    timelineLoadTimeoutRef.current = window.setTimeout(() => {
      timelineLoadTimeoutRef.current = null;
      lastTimelineFrameCountRef.current = count;
      void loadTimelineFrames(videoPath, count);
    }, 120);

    return () => {
      if (timelineLoadTimeoutRef.current !== null) {
        window.clearTimeout(timelineLoadTimeoutRef.current);
        timelineLoadTimeoutRef.current = null;
      }
    };
  }, [loadTimelineFrames, timelineFrames.length, timelineWidth, videoInfo, videoPath]);

  useEffect(() => {
    return () => {
      cancelPendingPreviewLoads();
    };
  }, [cancelPendingPreviewLoads]);

  return {
    previewFrame,
    timelineFrames,
    loadingPreview,
    loadingTimelineFrames,
    previewFrameError,
    timelineFramesError,
    loadPreviewFrame,
    loadTimelineFrames,
    updatePreviewFrameDebounced,
    retryStaticPreview,
    retryTimelineFrames,
    cancelPendingPreviewLoads,
    clearPendingPreviewTimeout,
    setVideoCacheKey,
    preparePreviewFramesForVideoLoad,
    clearTimelineFrames,
    resetPreviewFramesAfterVideoLoadFailure,
    clearPreviewFrameErrors,
  };
}
