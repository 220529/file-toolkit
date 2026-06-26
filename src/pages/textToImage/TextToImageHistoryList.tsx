import { convertFileSrc } from "@tauri-apps/api/core";
import { Badge } from "../../components/ui/badge";
import { cn } from "../../utils/cn";
import { getBaseName } from "../../utils/path";
import type { TextToImageHistoryItem } from "./types";

interface TextToImageHistoryListProps {
  history: TextToImageHistoryItem[];
  selectedPath?: string;
  onSelect: (item: TextToImageHistoryItem) => void;
  onClear: () => void;
}

export function TextToImageHistoryList({
  history,
  selectedPath,
  onSelect,
  onClear,
}: TextToImageHistoryListProps) {
  return (
    <>
      <div className="mb-3 flex items-center justify-between">
        <div className="text-xs font-semibold text-slate-700">最近产出</div>
        {history.length > 0 && (
          <button className="text-xs text-slate-500 hover:text-slate-900" onClick={onClear}>
            清空
          </button>
        )}
      </div>
      {history.length === 0 ? (
        <div className="rounded-[8px] border border-dashed border-slate-200 bg-white px-3 py-4 text-center text-xs text-slate-400">暂无记录</div>
      ) : (
        <div className="grid max-h-[180px] gap-2 overflow-auto pr-1">
          {history.map((item) => (
            <button
              key={item.path}
              type="button"
              onClick={() => onSelect(item)}
              className={cn(
                "grid grid-cols-[52px_1fr_auto] items-center gap-3 rounded-[8px] border bg-white p-2 text-left transition hover:border-blue-200 hover:bg-blue-50/40",
                selectedPath === item.path ? "border-blue-200 ring-1 ring-blue-100" : "border-slate-200"
              )}
            >
              <img src={convertFileSrc(item.path)} alt="" className="h-12 w-12 rounded-[6px] object-cover" />
              <div className="min-w-0">
                <div className="truncate text-xs font-medium text-slate-800">{getBaseName(item.path)}</div>
                <div className="mt-0.5 truncate text-[11px] text-slate-400">{item.prompt}</div>
              </div>
              <Badge>{item.mime_type.split("/")[1]?.toUpperCase()}</Badge>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
