import { invoke } from "@tauri-apps/api/core";

export interface DedupFileInfo {
  path: string;
  name: string;
  size: number;
  created: number;
  modified: number;
}

export interface DuplicateGroup {
  hash: string;
  size: number;
  files: DedupFileInfo[];
}

export interface DedupIssue {
  path: string;
  reason: string;
}

export interface DedupResult {
  groups: DuplicateGroup[];
  total_groups: number;
  total_duplicates: number;
  wasted_size: number;
  skipped_files: number;
  unreadable_files: number;
  permission_denied_files: number;
  hash_failed_files: number;
  sample_errors: DedupIssue[];
}

export interface DedupProgress {
  task_id: string;
  stage: string;
  current: number;
  total: number;
  percent: number;
}

export type DedupScope = "media" | "all";

export interface DeleteFailure {
  path: string;
  reason: string;
}

export interface DeleteFilesResult {
  deleted_count: number;
  failed: DeleteFailure[];
}

export interface DeleteGroupInput {
  files: string[];
}

export interface DeleteFilesRequest {
  paths: string[];
  useTrash: boolean;
  groups: DeleteGroupInput[];
  verifyBeforeDelete: boolean;
}

export function getFileThumbnail(path: string) {
  return invoke<string>("get_file_thumbnail", { path });
}

export function findDuplicates(path: string, taskId: string, scope: DedupScope) {
  return invoke<DedupResult>("find_duplicates", { path, taskId, scope });
}

export function deleteFiles(request: DeleteFilesRequest) {
  return invoke<DeleteFilesResult>("delete_files", { ...request });
}

export function cancelDedup(taskId: string) {
  return invoke<void>("cancel_dedup", { taskId });
}
