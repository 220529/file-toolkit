import type { RefObject } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Checkbox } from "../../components/ui/checkbox";
import { Icon } from "../../components/ui/icon";
import { formatSize } from "../../utils/format";
import { cn } from "../../utils/cn";
import {
  formatDate,
  getFileIconName,
  getSortedFiles,
  isPreviewable,
  type VirtualItem,
} from "./utils";

interface DedupGroupListProps {
  expandedGroups: Set<string>;
  fileThumbnails: Map<string, string>;
  groupThumbnails: Map<string, string>;
  listContainerRef: RefObject<HTMLDivElement | null>;
  onAttachMeasuredNode: (hash: string) => (node: HTMLDivElement | null) => void;
  onLoadFileThumbnail: (path: string) => void | Promise<void>;
  onLoadGroupThumbnail: (hash: string, path: string) => void | Promise<void>;
  onOpenFile: (path: string) => void | Promise<void>;
  onPreviewImage: (image: string) => void;
  onRevealInDir: (path: string) => void | Promise<void>;
  onToggleGroup: (hash: string) => void;
  onToggleSelect: (path: string) => void;
  selected: Set<string>;
  totalHeight: number;
  visibleItems: VirtualItem[];
}

export function DedupGroupList({
  expandedGroups,
  fileThumbnails,
  groupThumbnails,
  listContainerRef,
  onAttachMeasuredNode,
  onLoadFileThumbnail,
  onLoadGroupThumbnail,
  onOpenFile,
  onPreviewImage,
  onRevealInDir,
  onToggleGroup,
  onToggleSelect,
  selected,
  totalHeight,
  visibleItems,
}: DedupGroupListProps) {
  return (
    <div ref={listContainerRef} className="relative" style={{ height: `${totalHeight}px` }}>
      {visibleItems.map((item) => {
        const group = item.group;
        const idx = item.index;
        const sortedFiles = getSortedFiles(group);
        const representativeFile = sortedFiles[0];
        const groupThumb = groupThumbnails.get(group.hash);
        const hasGroupThumb = groupThumbnails.has(group.hash);
        const previewable = isPreviewable(representativeFile.name);
        const expanded = expandedGroups.has(group.hash);

        return (
          <div
            key={group.hash}
            ref={onAttachMeasuredNode(group.hash)}
            className="absolute left-0 right-0 pb-4"
            style={{ top: `${item.top}px` }}
          >
            <Card
              className="overflow-hidden"
              onMouseEnter={() => {
                if (previewable) {
                  void onLoadGroupThumbnail(group.hash, representativeFile.path);
                }
              }}
            >
              <CardHeader className="cursor-pointer bg-slate-50/85" onClick={() => onToggleGroup(group.hash)}>
                <div className="flex min-w-0 items-center gap-4">
                  {previewable ? (
                    <div
                      className="flex h-16 w-16 flex-shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-[10px] bg-slate-200"
                      onClick={(event) => {
                        event.stopPropagation();
                        if (groupThumb) onPreviewImage(groupThumb);
                      }}
                    >
                      {groupThumb ? (
                        <img src={groupThumb} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <div className="flex flex-col items-center gap-1 text-center text-xs text-slate-400">
                          <Icon name={getFileIconName(representativeFile.name)} size={22} />
                          <div>{hasGroupThumb ? "暂无封面" : "加载封面"}</div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="flex h-16 w-16 flex-shrink-0 items-center justify-center rounded-[10px] bg-slate-100 text-slate-500">
                      <Icon name={getFileIconName(representativeFile.name)} size={28} />
                    </div>
                  )}
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <CardTitle className="text-[15px]">第 {idx + 1} 组</CardTitle>
                      <Badge tone="default">{group.files.length} 个文件</Badge>
                      <Badge tone={expanded ? "info" : "default"}>{expanded ? "收起" : "展开"}</Badge>
                    </div>
                    <div className="mt-1 truncate text-sm text-slate-500">{representativeFile.name}</div>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                      <span>{formatSize(group.size)} / 文件</span>
                      <span>哈希片段 {group.hash.slice(0, 10)}</span>
                    </div>
                  </div>
                </div>
                <Badge tone="warning">预计释放 {formatSize(group.size * (group.files.length - 1))}</Badge>
              </CardHeader>
              {expanded && (
                <CardContent className="space-y-2 px-3 py-3">
                  {sortedFiles.map((file, fileIdx) => (
                    <div
                      key={file.path}
                      onClick={() => onToggleSelect(file.path)}
                      onMouseEnter={() => {
                        if (isPreviewable(file.name)) {
                          void onLoadFileThumbnail(file.path);
                        }
                      }}
                      className={cn(
                        "flex cursor-pointer items-center gap-3 rounded-[10px] border px-3 py-3 transition",
                        selected.has(file.path)
                          ? "border-rose-200 bg-rose-50"
                          : "border-transparent bg-slate-50/80 hover:border-slate-200 hover:bg-white"
                      )}
                    >
                      <Checkbox
                        checked={selected.has(file.path)}
                        onClick={(event) => event.stopPropagation()}
                        onCheckedChange={() => onToggleSelect(file.path)}
                      />
                      {isPreviewable(file.name) ? (
                        <div
                          className="flex h-11 w-11 flex-shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-xl bg-slate-100 text-xl"
                          onClick={(event) => {
                            event.stopPropagation();
                            const thumb = fileThumbnails.get(file.path);
                            if (thumb) onPreviewImage(thumb);
                            else void onLoadFileThumbnail(file.path);
                          }}
                        >
                          {fileThumbnails.get(file.path) ? (
                            <img src={fileThumbnails.get(file.path)} alt="" className="h-full w-full object-cover" />
                          ) : (
                            <Icon name={getFileIconName(file.name)} size={18} className="text-slate-400" />
                          )}
                        </div>
                      ) : (
                        <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-500">
                          <Icon name={getFileIconName(file.name)} size={20} />
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-slate-900">{file.name}</div>
                        <div className="truncate text-xs text-slate-500">{file.path}</div>
                        <div className="mt-1 text-xs text-slate-400">
                          创建 {formatDate(file.created)} · 修改 {formatDate(file.modified)}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(event) => {
                            event.stopPropagation();
                            void onOpenFile(file.path);
                          }}
                        >
                          打开
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(event) => {
                            event.stopPropagation();
                            void onRevealInDir(file.path);
                          }}
                        >
                          位置
                        </Button>
                      </div>
                      {fileIdx === 0 && <Badge tone="success">建议保留</Badge>}
                    </div>
                  ))}
                </CardContent>
              )}
            </Card>
          </div>
        );
      })}
    </div>
  );
}
