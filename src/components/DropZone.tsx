import type { ReactNode } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useWindowDrop } from "../hooks/useWindowDrop";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent } from "./ui/card";
import { Icon } from "./ui/icon";
import { cn } from "../utils/cn";
import { getBaseName } from "../utils/path";

interface DropZoneProps {
  onSelect: (path: string) => void;
  loading?: boolean;
  selectedPath?: string;
  active?: boolean;
  footerActions?: ReactNode;
}

export default function DropZone({ onSelect, loading, selectedPath, active = true, footerActions }: DropZoneProps) {
  const { dragging } = useWindowDrop({
    active,
    onDrop: (paths) => {
      if (loading) return;
      onSelect(paths[0]);
    },
  });

  async function handleClick() {
    if (loading) return;
    const selected = await open({ directory: true, title: "选择文件夹" });
    if (selected) onSelect(selected as string);
  }

  return (
    <Card className="overflow-hidden">
      <CardContent className="px-5 py-5">
        <div
          onClick={handleClick}
          className={cn(
            "drop-zone flex flex-col items-center justify-center",
            dragging && active && "dragging"
          )}
        >
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-[8px] border border-slate-200 bg-slate-50 text-[var(--brand-700)]">
            <Icon
              name={dragging ? "folderOpen" : "folder"}
              size={26}
              className={loading ? "animate-pulse" : undefined}
            />
          </div>
          <div className="text-base font-semibold text-slate-900">
            {loading ? "正在处理，请稍候" : dragging ? "松开以载入文件夹" : "拖入文件夹，或点击选择"}
          </div>
          <div className="mt-4">
            <Button variant="primary" size="sm">
              {loading ? "处理中…" : "选择文件夹"}
            </Button>
          </div>
        </div>

        {selectedPath && (
          <div className="mt-4 flex flex-wrap items-center gap-3 rounded-[8px] border border-slate-200 bg-slate-50 px-4 py-3">
            <Badge tone="info">当前目录</Badge>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-slate-800">{getBaseName(selectedPath) || selectedPath}</div>
              <div className="truncate text-xs text-slate-500">{selectedPath}</div>
            </div>
            {footerActions && <div className="flex flex-wrap items-center gap-2">{footerActions}</div>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
