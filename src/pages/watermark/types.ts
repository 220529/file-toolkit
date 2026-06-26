export interface RectSelection {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CanvasPoint {
  mx: number;
  my: number;
  ox: number;
  oy: number;
}

export interface ComparePoint {
  x: number;
  y: number;
  ox: number;
  oy: number;
}

export interface LoadImageOptions {
  preserveEditContext?: boolean;
}

export interface SmartTip {
  tone: "info" | "warning" | "success";
  title: string;
  description: string;
  primaryAction?: {
    label: string;
    onClick: () => void;
  };
  secondaryAction?: {
    label: string;
    onClick: () => void;
  };
}

export type DragMode = "none" | "move" | "create" | "nw" | "ne" | "sw" | "se" | "n" | "s" | "e" | "w";
export type RemoveMode = "blur" | "fill" | "repair";
export type RepairTool = "rect" | "brush" | "erase";
export type RepairMaskBase = "rect" | "blank";
export type EditorMode = "simple" | "advanced";
