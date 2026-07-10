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
      <CardContent className="px-4 py-4">
        <div
          onClick={handleClick}
          className={cn(
            "drop-zone flex flex-col items-stretch justify-between gap-4 text-left md:flex-row md:items-center",
            dragging && active && "dragging"
          )}
        >
          <div className="flex min-w-0 items-center gap-4">
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-[8px] border border-[var(--stroke)] bg-[var(--brand-50)] text-[var(--brand-700)]">
              <Icon
                name={dragging ? "folderOpen" : "folder"}
                size={26}
                className={loading ? "animate-pulse" : undefined}
              />
            </div>
            <div className="min-w-0">
              <div className="text-[17px] font-semibold text-[var(--text-strong)]">
                {loading ? "正在处理，请稍候" : dragging ? "松开以载入文件夹" : "拖入文件夹，或点击选择"}
              </div>
              <div className="mt-1 text-sm text-[var(--text-muted)] md:truncate">
                支持本地目录扫描，结果会保留在当前工作区
              </div>
            </div>
          </div>
          <Button variant="primary" size="sm" className="shrink-0 self-start md:self-auto">
            {loading ? "处理中..." : "选择文件夹"}
          </Button>
        </div>

        {selectedPath && (
          <div className="mt-3 flex flex-wrap items-center gap-3 rounded-[8px] border border-[var(--stroke)] bg-[#f7f8f5] px-4 py-3">
            <Badge tone="info">当前目录</Badge>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-[var(--text-strong)]">{getBaseName(selectedPath) || selectedPath}</div>
              <div className="truncate text-xs text-[var(--text-muted)]">{selectedPath}</div>
            </div>
            {footerActions && <div className="flex flex-wrap items-center gap-2">{footerActions}</div>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
