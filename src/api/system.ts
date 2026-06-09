import { invoke } from "@tauri-apps/api/core";

export interface PathMetadata {
  size: number;
  modified_ms: number;
  is_file: boolean;
  is_dir: boolean;
}

export function pathExists(path: string) {
  return invoke<boolean>("path_exists", { path });
}

export function getPathMetadata(path: string) {
  return invoke<PathMetadata>("get_path_metadata", { path });
}

export function openFilePath(path: string) {
  return invoke<void>("open_file_path", { path });
}

export function revealFilePath(path: string) {
  return invoke<void>("reveal_file_path", { path });
}

export function getLogPath() {
  return invoke<string>("get_log_path");
}

export function getRecentLogs(lines: number) {
  return invoke<string>("get_recent_logs", { lines });
}
