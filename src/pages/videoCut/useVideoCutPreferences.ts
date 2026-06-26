import { useEffect, useState } from "react";

const PRECISE_MODE_STORAGE_KEY = "video-cut-precise-mode";
const LOOP_PLAYBACK_STORAGE_KEY = "video-cut-loop-playback";
const ADVANCED_CONTROLS_STORAGE_KEY = "video-cut-advanced-controls";

function readStoredBoolean(key: string) {
  const value = window.localStorage.getItem(key);
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function usePersistedBooleanState(
  key: string,
  defaultValue: boolean,
  readErrorMessage: string,
  writeErrorMessage: string
) {
  const [value, setValue] = useState(defaultValue);

  useEffect(() => {
    try {
      const storedValue = readStoredBoolean(key);
      if (storedValue !== null) {
        setValue(storedValue);
      }
    } catch (error) {
      console.error(readErrorMessage, error);
    }
  }, [key, readErrorMessage]);

  useEffect(() => {
    try {
      window.localStorage.setItem(key, value ? "true" : "false");
    } catch (error) {
      console.error(writeErrorMessage, error);
    }
  }, [key, value, writeErrorMessage]);

  return [value, setValue] as const;
}

export function useVideoCutPreferences() {
  const [preciseMode, setPreciseMode] = usePersistedBooleanState(
    PRECISE_MODE_STORAGE_KEY,
    false,
    "读取精确模式偏好失败:",
    "保存精确模式偏好失败:"
  );
  const [loopClipPlayback, setLoopClipPlayback] = usePersistedBooleanState(
    LOOP_PLAYBACK_STORAGE_KEY,
    false,
    "读取循环播放偏好失败:",
    "保存循环播放偏好失败:"
  );
  const [showAdvancedControls, setShowAdvancedControls] = usePersistedBooleanState(
    ADVANCED_CONTROLS_STORAGE_KEY,
    false,
    "读取高级微调展开状态失败:",
    "保存高级微调展开状态失败:"
  );

  return {
    preciseMode,
    setPreciseMode,
    loopClipPlayback,
    setLoopClipPlayback,
    showAdvancedControls,
    setShowAdvancedControls,
  };
}
