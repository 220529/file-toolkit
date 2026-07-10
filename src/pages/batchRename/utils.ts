import {
  fileSystemCollisionKey,
  getBaseName,
  getDirName,
  getExtension,
  getPathSeparator,
  joinPath,
  stripExtension,
} from "../../utils/path";
import type { ExtensionCaseMode, NameCaseMode, RenamePreviewItem, RenamePreviewOptions, RenameRule } from "./types";

export const defaultRenameRule: RenameRule = {
  prefix: "",
  suffix: "",
  find: "",
  replace: "",
  nameCase: "keep",
  extensionCase: "keep",
  numbering: true,
  startNumber: 1,
  padding: 2,
};

export function buildRenamePreview(
  paths: string[],
  rule: RenameRule,
  options: RenamePreviewOptions = {}
): RenamePreviewItem[] {
  const orderedPaths = dedupePaths(paths);
  const sourceCounts = orderedPaths.reduce<Record<string, number>>((acc, path) => {
    const key = fileSystemCollisionKey(path);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const sourcePaths = new Set(Object.keys(sourceCounts));
  const rawItems = orderedPaths.map((path, index) => buildPreviewItem(path, index, rule));
  const counts = rawItems.reduce<Record<string, number>>((acc, item) => {
    const key = fileSystemCollisionKey(item.nextPath);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const existingTargetPaths = new Set(
    Array.from(options.existingTargetPaths ?? []).map(fileSystemCollisionKey)
  );

  return rawItems.map((item) => {
    const sourceKey = fileSystemCollisionKey(item.path);
    const targetKey = fileSystemCollisionKey(item.nextPath);
    if (!item.nextName.trim()) {
      return { ...item, status: "invalid", reason: "文件名为空" };
    }
    if (/[\\/]/.test(item.nextName)) {
      return { ...item, status: "invalid", reason: "文件名不能包含路径分隔符" };
    }
    if (sourceCounts[sourceKey] > 1) {
      return { ...item, status: "duplicate", reason: "源路径重复或仅大小写不同" };
    }
    if (counts[targetKey] > 1) {
      return { ...item, status: "duplicate", reason: "目标文件名重复" };
    }
    if (item.changed && sourcePaths.has(targetKey) && sourceKey !== targetKey) {
      return { ...item, status: "duplicate", reason: "目标与列表中的源文件冲突" };
    }
    if (item.changed && sourceKey !== targetKey && existingTargetPaths.has(targetKey)) {
      return { ...item, status: "exists", reason: "目标文件已存在" };
    }
    if (!item.changed) {
      return { ...item, status: "unchanged", reason: "文件名没有变化" };
    }
    return item;
  });
}

export function readyRenameOperations(items: RenamePreviewItem[]) {
  return items
    .filter((item) => item.status === "ready")
    .map((item) => ({
      from: item.path,
      to: item.nextPath,
    }));
}

export function hasBlockingPreviewIssue(items: RenamePreviewItem[]) {
  return items.some((item) => item.status !== "ready");
}

function buildPreviewItem(path: string, index: number, rule: RenameRule): RenamePreviewItem {
  const originalName = getBaseName(path);
  const directory = getDirName(path);
  const separator = getPathSeparator(path);
  const extension = getExtension(originalName);
  const stem = extension ? stripExtension(originalName) : originalName;
  const numbered = rule.numbering ? formatNumber(rule.startNumber + index, rule.padding) : "";

  let nextStem = stem;
  if (rule.find) {
    nextStem = nextStem.split(rule.find).join(rule.replace);
  }
  nextStem = applyNameCase(`${rule.prefix}${nextStem}${rule.suffix}${numbered}`, rule.nameCase);
  const nextExtension = extension ? applyExtensionCase(extension, rule.extensionCase) : "";
  const nextName = nextExtension ? `${nextStem}.${nextExtension}` : nextStem;
  const nextPath = joinPath(directory, nextName, separator);

  return {
    path,
    directory,
    originalName,
    nextName,
    nextPath,
    changed: nextPath !== path,
    status: "ready",
  };
}

function formatNumber(value: number, padding: number) {
  const normalized = Math.max(0, Math.floor(value));
  return normalized.toString().padStart(Math.max(1, Math.floor(padding)), "0");
}

function applyNameCase(value: string, mode: NameCaseMode) {
  if (mode === "lower") return value.toLowerCase();
  if (mode === "upper") return value.toUpperCase();
  if (mode === "title") {
    return value.replace(/\b[a-z]/g, (character) => character.toUpperCase());
  }
  return value;
}

function applyExtensionCase(value: string, mode: ExtensionCaseMode) {
  if (mode === "lower") return value.toLowerCase();
  if (mode === "upper") return value.toUpperCase();
  return value;
}

function dedupePaths(paths: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    if (!path || seen.has(path)) continue;
    seen.add(path);
    result.push(path);
  }
  return result;
}

export function collectRenameTargetPaths(items: RenamePreviewItem[]) {
  const sourcePaths = new Set(items.map((item) => fileSystemCollisionKey(item.path)));
  return Array.from(
    new Set(
      items
        .filter(
          (item) =>
            item.changed &&
            item.status === "ready" &&
            !sourcePaths.has(fileSystemCollisionKey(item.nextPath))
        )
        .map((item) => item.nextPath)
    )
  );
}
