import { useMemo, useState } from "react";
import {
  generateImage,
  type GeneratedImage,
  type ImageBackground,
  type ImageModel,
  type ImageOutputFormat,
  type ImageQuality,
  type ImageSize,
} from "../../api/tauri";
import { useTaskReporter } from "../../components/TaskCenter";
import { useToast } from "../../components/Toast";
import { createTaskId } from "../../utils/id";
import { officialBaseUrl } from "./options";
import type { ProviderMode, TextToImageHistoryItem } from "./types";

interface GenerateTextToImageInput {
  prompt: string;
  effectivePrompt: string;
  apiKey: string;
  providerMode: ProviderMode;
  baseUrl: string;
  effectiveBaseUrl: string;
  model: ImageModel;
  size: ImageSize;
  quality: ImageQuality;
  background: ImageBackground;
  outputFormat: ImageOutputFormat;
  outputDir: string;
  streaming: boolean;
}

export function useTextToImageGeneration() {
  const toast = useToast();
  const taskId = useMemo(() => createTaskId("text-image"), []);
  const { reportTask, clearTask } = useTaskReporter(taskId);
  const [generating, setGenerating] = useState(false);
  const [lastResult, setLastResult] = useState<GeneratedImage | null>(null);
  const [history, setHistory] = useState<TextToImageHistoryItem[]>([]);

  async function generate(input: GenerateTextToImageInput) {
    if (!input.prompt.trim()) {
      toast.warning("请输入提示词");
      return;
    }

    setGenerating(true);
    reportTask({
      title: "文生图",
      stage: "生成图片",
      detail: `${input.size} · ${input.model} · ${input.effectiveBaseUrl || "默认服务"}`,
    });

    try {
      const requestBaseUrl =
        input.providerMode === "custom"
          ? input.baseUrl.trim() || undefined
          : input.providerMode === "official"
            ? officialBaseUrl
            : undefined;
      const result = await generateImage({
        prompt: input.effectivePrompt,
        apiKey: input.providerMode === "codex" ? undefined : input.apiKey.trim() || undefined,
        baseUrl: requestBaseUrl,
        useCodexConfig: input.providerMode === "codex",
        model: input.model,
        size: input.size,
        quality: input.quality,
        background: input.background,
        outputFormat: input.outputFormat,
        outputDir: input.outputDir.trim() || undefined,
        stream: input.streaming,
      });
      setLastResult(result);
      setHistory((current) => [{ ...result, prompt: input.prompt.trim() }, ...current].slice(0, 8));
      toast.success("图片已生成");
    } catch (error) {
      toast.error("生成失败: " + error);
    } finally {
      setGenerating(false);
      clearTask();
    }
  }

  return {
    generating,
    lastResult,
    setLastResult,
    history,
    clearHistory: () => setHistory([]),
    generate,
  };
}
