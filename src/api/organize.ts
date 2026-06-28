import { invoke } from "@tauri-apps/api/core";

export interface OrganizeOperation {
  from: string;
  to: string;
}

export interface OrganizeFilesRequest {
  operations: OrganizeOperation[];
}

export interface OrganizeResultItem {
  from: string;
  to: string;
  ok: boolean;
  error?: string | null;
}

export interface OrganizeFilesResult {
  total: number;
  moved: number;
  failed: number;
  elapsed_ms: number;
  items: OrganizeResultItem[];
}

export function organizeFiles(request: OrganizeFilesRequest) {
  return invoke<OrganizeFilesResult>("organize_files", { request });
}
