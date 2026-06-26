import type { WatermarkResult } from "../../api/tauri";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { cn } from "../../utils/cn";

interface WatermarkResultActionsProps {
  result: WatermarkResult | null;
  batchResults: WatermarkResult[];
  onOpenFile: (path: string) => void | Promise<void>;
  onRevealInDir: (path: string) => void | Promise<void>;
  onContinueRefine: () => void | Promise<void>;
}

export function WatermarkResultActions({
  result,
  batchResults,
  onOpenFile,
  onRevealInDir,
  onContinueRefine,
}: WatermarkResultActionsProps) {
  return (
    <>
      {result && (
        <div className="space-y-3 rounded-[10px] border border-emerald-100 bg-emerald-50/70 px-4 py-4">
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm font-medium text-emerald-900">最近输出</div>
            <Badge tone="success">已生成</Badge>
          </div>
          <div className="break-all font-mono text-xs leading-5 text-emerald-900/80">{result.output_path}</div>
          <div className="grid gap-2 sm:grid-cols-2">
            <Button variant="secondary" size="sm" onClick={() => void onOpenFile(result.output_path)}>
              打开结果
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void onRevealInDir(result.output_path)}>
              打开位置
            </Button>
            <Button variant="primary" size="sm" className="sm:col-span-2" onClick={() => void onContinueRefine()}>
              继续精修当前结果
            </Button>
          </div>
          <div className="text-xs leading-5 text-emerald-900/70">
            会保留当前模式和选区，并清空上一轮手工蒙版，方便在结果图上继续补涂或微调。
          </div>
        </div>
      )}

      {batchResults.length > 0 && (
        <div className="space-y-3 rounded-[10px] border border-sky-100 bg-sky-50/70 px-4 py-4">
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm font-medium text-sky-900">批量结果</div>
            <Badge tone="info">
              成功 {batchResults.filter((item) => item.success).length} / {batchResults.length}
            </Badge>
          </div>
          <div className="max-h-56 space-y-2 overflow-auto pr-1">
            {batchResults.map((item, index) => (
              <div
                key={`${item.output_path || item.message}-${index}`}
                className={cn(
                  "rounded-[10px] border px-3 py-3",
                  item.success ? "border-emerald-100 bg-white/80" : "border-rose-100 bg-white/80"
                )}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className={cn("truncate text-sm font-medium", item.success ? "text-slate-900" : "text-rose-900")}>
                      {item.success ? item.output_path : item.message}
                    </div>
                    {item.success && <div className="mt-1 truncate text-xs text-slate-500">{item.message}</div>}
                  </div>
                  <Badge tone={item.success ? "success" : "danger"}>{item.success ? "成功" : "失败"}</Badge>
                </div>
                {item.success && item.output_path && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button variant="secondary" size="sm" onClick={() => void onOpenFile(item.output_path)}>
                      打开
                    </Button>
                    <Button variant="secondary" size="sm" onClick={() => void onRevealInDir(item.output_path)}>
                      定位
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
