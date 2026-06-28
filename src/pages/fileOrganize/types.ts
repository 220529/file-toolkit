export type OrganizeMode = "date" | "type" | "extension";

export type DateGranularity = "year" | "month" | "day";

export interface OrganizeFile {
  path: string;
  size: number;
  modifiedMs: number;
}

export interface OrganizeRule {
  mode: OrganizeMode;
  dateGranularity: DateGranularity;
  outputDir: string;
}

export interface OrganizePreviewOptions {
  existingTargetPaths?: Set<string>;
}

export type OrganizePreviewStatus = "ready" | "invalid" | "duplicate" | "unchanged" | "exists";

export interface OrganizePreviewItem {
  path: string;
  fileName: string;
  size: number;
  modifiedMs: number;
  targetFolder: string;
  targetPath: string;
  status: OrganizePreviewStatus;
  reason?: string;
}
