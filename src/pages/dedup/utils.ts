import type { DedupFileInfo as FileInfo, DedupProgress, DuplicateGroup } from "../../api/tauri";
import type { IconName } from "../../components/ui/icon";

export interface DedupStepSnapshot {
  scannedFiles: number;
  sampleCurrent: number;
  sampleTotal: number;
  confirmCurrent: number;
  confirmTotal: number;
}

export type VirtualItem = {
  group: DuplicateGroup;
  index: number;
  top: number;
  height: number;
};

export const DEDUP_STAGE_ORDER: Record<string, number> = {
  "准备扫描文件夹": 0,
  "扫描文件": 1,
  "初步筛选重复文件": 2,
  "确认重复文件": 3,
  "完成": 4,
};

export const VIRTUAL_OVERSCAN = 900;

export function estimateGroupHeight(group: DuplicateGroup, expanded: boolean) {
  const base = 108;
  if (!expanded) return base;
  return base + group.files.length * 72 + 14;
}

export function getDedupProgressText(progress: DedupProgress) {
  const prefix = progress.detail ? `${progress.detail} · ` : "";

  switch (progress.stage) {
    case "准备扫描文件夹":
      return "准备中";
    case "扫描文件":
      return `${prefix}已扫描 ${progress.current.toLocaleString()} 个文件`;
    case "初步筛选重复文件":
      return progress.total > 0
        ? `${prefix}候选 ${progress.current.toLocaleString()} / ${progress.total.toLocaleString()}`
        : `${prefix}筛选中`;
    case "确认重复文件":
      return progress.total > 0
        ? `${prefix}确认 ${progress.current.toLocaleString()} / ${progress.total.toLocaleString()}`
        : `${prefix}确认中`;
    default:
      return progress.total > 0
        ? `${prefix}${progress.current.toLocaleString()} / ${progress.total.toLocaleString()}`
        : `${prefix}${progress.current.toLocaleString()}`;
  }
}

export function createEmptyStepSnapshot(): DedupStepSnapshot {
  return {
    scannedFiles: 0,
    sampleCurrent: 0,
    sampleTotal: 0,
    confirmCurrent: 0,
    confirmTotal: 0,
  };
}

export function getStepStatus(currentStage: string, stepStage: string) {
  const currentOrder = DEDUP_STAGE_ORDER[currentStage] ?? 0;
  const stepOrder = DEDUP_STAGE_ORDER[stepStage] ?? 0;

  if (currentOrder > stepOrder) return "done";
  if (currentOrder === stepOrder) return "active";
  return "pending";
}

export function getStepProgress(currentStage: string, stepStage: string, current: number, total: number) {
  const status = getStepStatus(currentStage, stepStage);

  if (status === "done") {
    return { value: 100, indeterminate: false };
  }

  if (status === "pending") {
    return { value: 0, indeterminate: false };
  }

  if (stepStage === "扫描文件") {
    return { value: 0, indeterminate: true };
  }

  if (total > 0) {
    return { value: (current / total) * 100, indeterminate: false };
  }

  return { value: 0, indeterminate: true };
}

export function formatDate(timestamp: number) {
  if (!timestamp) return "未知时间";
  return new Date(timestamp * 1000).toLocaleString();
}

function compareTimestamp(a: number, b: number) {
  if (!a || !b || a === b) return 0;
  return a - b;
}

function comparePreferredFiles(a: FileInfo, b: FileInfo) {
  const createdCmp = compareTimestamp(a.created, b.created);
  if (createdCmp !== 0) return createdCmp;

  const modifiedCmp = compareTimestamp(a.modified, b.modified);
  if (modifiedCmp !== 0) return modifiedCmp;

  return a.path.localeCompare(b.path, "zh-CN");
}

export function getSortedFiles(group: DuplicateGroup) {
  return [...group.files].sort(comparePreferredFiles);
}

export function getRepresentativeFile(group: DuplicateGroup) {
  return getSortedFiles(group)[0];
}

export function getFileIconName(name: string): IconName {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  if (["jpg", "jpeg", "png", "gif", "bmp", "webp"].includes(ext)) return "image";
  if (["mp4", "mov", "avi", "mkv", "wmv", "flv", "webm"].includes(ext)) return "video";
  if (["mp3", "wav", "flac", "aac", "ogg"].includes(ext)) return "audio";
  if (["pdf", "doc", "docx", "txt", "md"].includes(ext)) return "document";
  if (["xls", "xlsx", "csv"].includes(ext)) return "spreadsheet";
  if (["zip", "rar", "7z", "tar", "gz"].includes(ext)) return "archive";
  return "file";
}

export function isPreviewable(name: string) {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  return ["jpg", "jpeg", "png", "gif", "bmp", "webp", "mp4", "mov", "avi", "mkv", "wmv", "flv", "webm"].includes(ext);
}
