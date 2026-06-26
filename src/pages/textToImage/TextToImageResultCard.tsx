import { convertFileSrc } from "@tauri-apps/api/core";
import type { GeneratedImage } from "../../api/tauri";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "../../components/ui/card";
import { Icon } from "../../components/ui/icon";
import { Tooltip } from "../../components/ui/tooltip";
import { formatSize } from "../../utils/format";
import { formatCreatedTime } from "./utils";
import { TextToImageHistoryList } from "./TextToImageHistoryList";
import type { TextToImageHistoryItem } from "./types";

interface TextToImageResultCardProps {
  generating: boolean;
  lastResult: GeneratedImage | null;
  history: TextToImageHistoryItem[];
  onOpenFile: (path: string) => void;
  onRevealInDir: (path: string) => void;
  onSelectHistory: (item: TextToImageHistoryItem) => void;
  onClearHistory: () => void;
}

export function TextToImageResultCard({
  generating,
  lastResult,
  history,
  onOpenFile,
  onRevealInDir,
  onSelectHistory,
  onClearHistory,
}: TextToImageResultCardProps) {
  const resultSrc = lastResult ? convertFileSrc(lastResult.path) : "";

  return (
    <Card className="flex min-h-[520px] flex-col overflow-hidden">
      <CardHeader className="items-center">
        <div className="min-w-0">
          <CardTitle>结果</CardTitle>
          <div className="mt-1 text-xs text-slate-500">
            {lastResult ? `${lastResult.file_name} · ${formatSize(lastResult.size_bytes)}` : "等待生成"}
          </div>
        </div>
        {lastResult && (
          <div className="flex items-center gap-2">
            <Tooltip content="打开图片">
              <Button variant="secondary" size="icon" onClick={() => onOpenFile(lastResult.path)} aria-label="打开图片">
                <Icon name="image" size={16} />
              </Button>
            </Tooltip>
            <Tooltip content="定位文件">
              <Button variant="secondary" size="icon" onClick={() => onRevealInDir(lastResult.path)} aria-label="定位文件">
                <Icon name="folderOpen" size={16} />
              </Button>
            </Tooltip>
          </div>
        )}
      </CardHeader>

      <CardContent className="flex flex-1 flex-col gap-4">
        <div className="relative flex min-h-[360px] flex-1 items-center justify-center overflow-hidden rounded-[8px] border border-slate-200 bg-[linear-gradient(45deg,#f8fafc_25%,transparent_25%),linear-gradient(-45deg,#f8fafc_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#f8fafc_75%),linear-gradient(-45deg,transparent_75%,#f8fafc_75%)] bg-[length:20px_20px] bg-[position:0_0,0_10px,10px_-10px,-10px_0]">
          {generating ? (
            <div className="flex flex-col items-center gap-3 text-slate-500">
              <div className="flex h-12 w-12 items-center justify-center rounded-[8px] border border-blue-100 bg-blue-50 text-[var(--brand-700)]">
                <Icon name="magic" size={20} />
              </div>
              <div className="text-sm font-medium">生成中</div>
            </div>
          ) : lastResult ? (
            <img src={resultSrc} alt="生成结果" className="h-full max-h-[560px] w-full object-contain" />
          ) : (
            <div className="flex flex-col items-center gap-3 text-slate-400">
              <div className="flex h-12 w-12 items-center justify-center rounded-[8px] border border-slate-200 bg-white">
                <Icon name="image" size={20} />
              </div>
              <div className="text-sm font-medium">暂无图片</div>
            </div>
          )}
        </div>

        {lastResult && (
          <div className="grid gap-2 rounded-[8px] border border-slate-200 bg-slate-50 px-3 py-3 text-xs text-slate-600 md:grid-cols-2">
            <div className="truncate">
              <span className="text-slate-400">模型</span> {lastResult.model}
            </div>
            <div className="truncate">
              <span className="text-slate-400">时间</span> {formatCreatedTime(lastResult.created_ms)}
            </div>
            <div className="truncate md:col-span-2">
              <span className="text-slate-400">路径</span> {lastResult.path}
            </div>
            {lastResult.revised_prompt && (
              <div className="max-h-10 overflow-hidden leading-5 md:col-span-2">
                <span className="text-slate-400">修订</span> {lastResult.revised_prompt}
              </div>
            )}
          </div>
        )}
      </CardContent>

      <CardFooter className="block">
        <TextToImageHistoryList
          history={history}
          selectedPath={lastResult?.path}
          onSelect={onSelectHistory}
          onClear={onClearHistory}
        />
      </CardFooter>
    </Card>
  );
}
