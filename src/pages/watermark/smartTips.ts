import type { RemoveMode, RepairMaskBase, RepairTool, SmartTip } from "./types";

interface WatermarkSmartTipActions {
  openAdvancedMode: () => void;
  switchToPreciseRepair: () => void;
  switchToBrush: () => void;
  switchToErase: () => void;
  switchToBlankBrush: () => void;
  continueRefine: () => void;
  switchToRepairMode: () => void;
}

interface WatermarkSmartTipsInput {
  removeMode: RemoveMode;
  simpleMode: boolean;
  activeRepairTool: RepairTool;
  activeRepairMaskBase: RepairMaskBase;
  simpleRepairNeedsPrecision: boolean;
  selectionAreaPercent: string;
  selectionAreaRatio: number;
  manualStrokeCount: number;
  hasResult: boolean;
  actions: WatermarkSmartTipActions;
}

export function buildWatermarkSmartTips({
  removeMode,
  simpleMode,
  activeRepairTool,
  activeRepairMaskBase,
  simpleRepairNeedsPrecision,
  selectionAreaPercent,
  selectionAreaRatio,
  manualStrokeCount,
  hasResult,
  actions,
}: WatermarkSmartTipsInput): SmartTip[] {
  const smartTips: SmartTip[] = [];

  if (removeMode === "repair") {
    if (simpleMode) {
      smartTips.push({
        tone: "info",
        title: "当前是简洁模式",
        description: "现在只用矩形快速修复，先把水印框准就能直接处理。需要补涂、擦除或空蒙版时，再打开高级模式。",
        primaryAction: {
          label: "打开高级模式",
          onClick: actions.openAdvancedMode,
        },
      });
    }

    if (simpleRepairNeedsPrecision) {
      smartTips.unshift({
        tone: "warning",
        title: "当前选区偏大，直接修复会更容易发糊",
        description: `现在的选区约占整图 ${selectionAreaPercent}%。简洁模式更适合小水印；这种范围建议切到高级模式，用空蒙版只补涂水印本体。`,
        primaryAction: {
          label: "切到精修",
          onClick: actions.switchToPreciseRepair,
        },
      });
    }

    if (!simpleMode && activeRepairMaskBase === "blank" && manualStrokeCount === 0) {
      smartTips.push({
        tone: "warning",
        title: "空蒙版还没有修复区域",
        description: "当前矩形只用于定位，不会参与修复。执行前先切到补涂，把真正需要处理的区域画出来。",
        primaryAction: {
          label: "切到补涂",
          onClick: actions.switchToBrush,
        },
      });
    }

    if (!simpleMode && activeRepairMaskBase === "rect" && selectionAreaRatio > 0.12 && manualStrokeCount === 0) {
      smartTips.push({
        tone: "warning",
        title: "修复范围偏大",
        description: "当前矩形覆盖面积较大，整块修复容易伤到周边内容。更稳的做法是切到空蒙版，只涂水印本体。",
        primaryAction: {
          label: "改为空蒙版",
          onClick: actions.switchToBlankBrush,
        },
      });
    }

    if (!simpleMode && activeRepairTool === "rect" && manualStrokeCount > 0) {
      smartTips.push({
        tone: "info",
        title: "已经进入精修阶段",
        description: "你已经有手工蒙版了。继续微调时，直接切到补涂或擦除会比反复拖框更顺手。",
        primaryAction: {
          label: "切到补涂",
          onClick: actions.switchToBrush,
        },
        secondaryAction: {
          label: "切到擦除",
          onClick: actions.switchToErase,
        },
      });
    }

    if (hasResult) {
      smartTips.push({
        tone: "success",
        title: "结果图可以直接继续精修",
        description: "如果边缘还有一点不自然，直接进入结果图继续补涂或擦除，比重新从原图开始更省事。",
        primaryAction: {
          label: "继续精修",
          onClick: actions.continueRefine,
        },
      });
    }
  } else if (removeMode === "fill" && selectionAreaRatio > 0.08) {
    smartTips.push({
      tone: "warning",
      title: "填色区域偏大",
      description: "颜色覆盖更适合纯色背景和小范围遮挡。当前范围较大时，边缘会更容易显眼，建议改成基础修复。",
      primaryAction: {
        label: "切到基础修复",
        onClick: actions.switchToRepairMode,
      },
    });
  } else if (removeMode === "blur" && selectionAreaRatio > 0.12) {
    smartTips.push({
      tone: "warning",
      title: "模糊范围偏大",
      description: "模糊更适合快速遮挡。当前范围较大时，画面会明显发糊，建议缩小范围或换成基础修复。",
      primaryAction: {
        label: "切到基础修复",
        onClick: actions.switchToRepairMode,
      },
    });
  }

  return smartTips;
}
