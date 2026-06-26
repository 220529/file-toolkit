import { Card, CardContent } from "../../components/ui/card";
import { Icon } from "../../components/ui/icon";
import { cn } from "../../utils/cn";

interface WatermarkDropCardProps {
  dragging: boolean;
  loading: boolean;
  onSelectFile: () => void;
}

export function WatermarkDropCard({ dragging, loading, onSelectFile }: WatermarkDropCardProps) {
  return (
    <Card className="overflow-hidden">
      <CardContent className="px-5 py-5">
        <div
          onClick={onSelectFile}
          className={cn("drop-zone flex flex-col items-center justify-center", dragging && "dragging")}
        >
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-[8px] border border-slate-200 bg-slate-50 text-[var(--brand-700)]">
            <Icon
              name={dragging ? "folderOpen" : "magic"}
              size={30}
              className={loading ? "animate-pulse" : undefined}
            />
          </div>
          <div className="text-lg font-semibold text-slate-900">
            {loading ? "正在载入图片" : dragging ? "松开以载入图片" : "拖入图片，或点击选择"}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
