import { invoke } from "@tauri-apps/api/core";

export interface RenameOperation {
  from: string;
  to: string;
}

export interface BatchRenameRequest {
  operations: RenameOperation[];
}

export interface RenameResultItem {
  from: string;
  to: string;
  ok: boolean;
  error?: string | null;
}

export interface BatchRenameResult {
  total: number;
  renamed: number;
  failed: number;
  elapsed_ms: number;
  items: RenameResultItem[];
}

export function batchRename(request: BatchRenameRequest) {
  return invoke<BatchRenameResult>("batch_rename", { request });
}
