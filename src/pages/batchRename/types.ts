export type NameCaseMode = "keep" | "lower" | "upper" | "title";
export type ExtensionCaseMode = "keep" | "lower" | "upper";

export interface RenameRule {
  prefix: string;
  suffix: string;
  find: string;
  replace: string;
  nameCase: NameCaseMode;
  extensionCase: ExtensionCaseMode;
  numbering: boolean;
  startNumber: number;
  padding: number;
}

export interface RenamePreviewOptions {
  existingTargetPaths?: Set<string>;
}

export interface RenamePreviewItem {
  path: string;
  directory: string;
  originalName: string;
  nextName: string;
  nextPath: string;
  changed: boolean;
  status: "ready" | "unchanged" | "duplicate" | "invalid" | "exists";
  reason?: string;
}
