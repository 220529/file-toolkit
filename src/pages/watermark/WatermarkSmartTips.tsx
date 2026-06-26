import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { cn } from "../../utils/cn";
import type { SmartTip } from "./types";

interface WatermarkSmartTipsProps {
  tips: SmartTip[];
}

export function WatermarkSmartTips({ tips }: WatermarkSmartTipsProps) {
  return (
    <>
      {tips.slice(0, 2).map((tip, index) => (
        <div
          key={`${tip.title}-${index}`}
          className={cn(
            "space-y-3 rounded-[10px] border px-4 py-4",
            tip.tone === "warning" && "border-amber-100 bg-amber-50/80",
            tip.tone === "info" && "border-blue-100 bg-blue-50/75",
            tip.tone === "success" && "border-emerald-100 bg-emerald-50/75"
          )}
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-slate-900">{tip.title}</div>
              <div className="mt-1 text-xs leading-5 text-slate-600">{tip.description}</div>
            </div>
            <Badge tone={tip.tone === "warning" ? "warning" : tip.tone === "success" ? "success" : "info"}>
              提示
            </Badge>
          </div>
          {(tip.primaryAction || tip.secondaryAction) && (
            <div className="flex flex-wrap gap-2">
              {tip.primaryAction && (
                <Button variant="secondary" size="sm" onClick={tip.primaryAction.onClick}>
                  {tip.primaryAction.label}
                </Button>
              )}
              {tip.secondaryAction && (
                <Button variant="secondary" size="sm" onClick={tip.secondaryAction.onClick}>
                  {tip.secondaryAction.label}
                </Button>
              )}
            </div>
          )}
        </div>
      ))}
    </>
  );
}
