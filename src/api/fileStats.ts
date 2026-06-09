import { invoke } from "@tauri-apps/api/core";

export interface FileStatsEntry {
  extension: string;
  count: number;
  total_size: number;
}

export interface ScanIssue {
  path: string;
  reason: string;
}

export interface ScanResult {
  stats: FileStatsEntry[];
  total_files: number;
  folder_count: number;
  total_size: number;
  type_count: number;
  skipped_files: number;
  permission_denied_files: number;
  sample_errors: ScanIssue[];
}

export interface FileStatsProgress {
  task_id: string;
  stage: string;
  current: number;
  total: number;
  percent: number;
  elapsed_ms: number;
  files_per_second: number;
  skipped_files: number;
  permission_denied_files: number;
}

export function scanDirectory(path: string, taskId: string) {
  return invoke<ScanResult>("scan_directory", { path, taskId });
}

export function cancelFileStats(taskId: string) {
  return invoke<void>("cancel_file_stats", { taskId });
}
