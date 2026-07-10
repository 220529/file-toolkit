import { fileSystemCollisionKey, getBaseName, getExtension, getPathSeparator, joinPath } from "../../utils/path";
import type {
  DateGranularity,
  OrganizeFile,
  OrganizeMode,
  OrganizePreviewOptions,
  OrganizePreviewItem,
  OrganizeRule,
} from "./types";

const imageExtensions = new Set(["jpg", "jpeg", "png", "gif", "webp", "avif", "bmp", "tif", "tiff", "heic", "svg"]);
const videoExtensions = new Set(["mp4", "mov", "m4v", "mkv", "avi", "webm", "flv", "wmv"]);
const audioExtensions = new Set(["mp3", "wav", "m4a", "aac", "flac", "ogg", "opus", "wma"]);
const documentExtensions = new Set(["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "md", "csv", "json", "rtf"]);
const archiveExtensions = new Set(["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "dmg", "pkg"]);

export function buildOrganizePreview(
  files: OrganizeFile[],
  rule: OrganizeRule,
  options: OrganizePreviewOptions = {}
): OrganizePreviewItem[] {
  if (!rule.outputDir.trim()) {
    return files.map((file) => ({
      path: file.path,
      fileName: getBaseName(file.path),
      size: file.size,
      modifiedMs: file.modifiedMs,
      targetFolder: "",
      targetPath: "",
      status: "invalid",
      reason: "请选择目标目录",
    }));
  }

  const sourcePaths = new Set(files.map((file) => fileSystemCollisionKey(file.path)));
  const rawItems = files.map((file) => buildPreviewItem(file, rule));
  const targetCounts = rawItems.reduce<Record<string, number>>((acc, item) => {
    const key = fileSystemCollisionKey(item.targetPath);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const existingTargetPaths = new Set(
    Array.from(options.existingTargetPaths ?? []).map(fileSystemCollisionKey)
  );

  return rawItems.map((item) => {
    const targetKey = fileSystemCollisionKey(item.targetPath);
    if (!item.fileName.trim()) {
      return { ...item, status: "invalid", reason: "文件名为空" };
    }
    if (!item.targetFolder.trim()) {
      return { ...item, status: "invalid", reason: "目标分类为空" };
    }
    if (targetCounts[targetKey] > 1) {
      return { ...item, status: "duplicate", reason: "目标路径重复" };
    }
    if (sourcePaths.has(targetKey)) {
      return { ...item, status: "duplicate", reason: "目标与待归类源文件冲突" };
    }
    if (existingTargetPaths.has(targetKey)) {
      return { ...item, status: "exists", reason: "目标文件已存在" };
    }
    if (item.targetPath === item.path) {
      return { ...item, status: "unchanged", reason: "目标路径没有变化" };
    }
    return item;
  });
}

export function readyOrganizeOperations(items: OrganizePreviewItem[]) {
  return items
    .filter((item) => item.status === "ready")
    .map((item) => ({
      from: item.path,
      to: item.targetPath,
    }));
}

export function hasBlockingOrganizeIssue(items: OrganizePreviewItem[]) {
  return items.some((item) => item.status !== "ready");
}

export function folderForFile(file: OrganizeFile, mode: OrganizeMode, granularity: DateGranularity) {
  if (mode === "date") return formatDateFolder(file.modifiedMs, granularity);
  if (mode === "type") return classifyFileType(file.path);
  return formatExtensionFolder(file.path);
}

export function formatDateFolder(modifiedMs: number, granularity: DateGranularity) {
  const date = new Date(Number.isFinite(modifiedMs) && modifiedMs > 0 ? modifiedMs : Date.now());
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  if (granularity === "year") return year;
  if (granularity === "day") return `${year}-${month}-${day}`;
  return `${year}-${month}`;
}

export function classifyFileType(path: string) {
  const extension = getExtension(path).toLowerCase();
  if (imageExtensions.has(extension)) return "图片";
  if (videoExtensions.has(extension)) return "视频";
  if (audioExtensions.has(extension)) return "音频";
  if (documentExtensions.has(extension)) return "文档";
  if (archiveExtensions.has(extension)) return "压缩包";
  return "其他";
}

export function formatExtensionFolder(path: string) {
  const extension = getExtension(path).toLowerCase();
  return extension ? extension : "无扩展名";
}

function buildPreviewItem(file: OrganizeFile, rule: OrganizeRule): OrganizePreviewItem {
  const fileName = getBaseName(file.path);
  const separator = getPathSeparator(rule.outputDir);
  const targetFolder = sanitizeFolderName(folderForFile(file, rule.mode, rule.dateGranularity));
  const targetPath = joinPath(joinPath(rule.outputDir.trim(), targetFolder, separator), fileName, separator);

  return {
    path: file.path,
    fileName,
    size: file.size,
    modifiedMs: file.modifiedMs,
    targetFolder,
    targetPath,
    status: "ready",
  };
}

function sanitizeFolderName(value: string) {
  return value.replace(/[\\/:*?"<>|]/g, "-").trim();
}

export function collectOrganizeTargetPaths(items: OrganizePreviewItem[]) {
  const sourcePaths = new Set(items.map((item) => fileSystemCollisionKey(item.path)));
  return Array.from(
    new Set(
      items
        .filter(
          (item) =>
            item.status === "ready" &&
            item.targetPath &&
            !sourcePaths.has(fileSystemCollisionKey(item.targetPath))
        )
        .map((item) => item.targetPath)
    )
  );
}
