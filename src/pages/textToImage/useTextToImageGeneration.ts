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
import type { ProviderMode, TextToImageHistoryEntry } from "./types";
import {
  loadTextToImageHistory,
  maxStoredTextToImageHistory,
  persistTextToImageHistory,
} from "./utils";

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
  const [history, setHistory] = useState<TextToImageHistoryEntry[]>(loadTextToImageHistory);
  const clearTaskSoon = (delay = 1200) => {
    window.setTimeout(clearTask, delay);
  };

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
        input.providerMode === "default" || input.providerMode === "custom"
          ? input.baseUrl.trim() || undefined
          : officialBaseUrl;
      const result = await generateImage({
        prompt: input.effectivePrompt,
        apiKey: input.apiKey.trim() || undefined,
        baseUrl: requestBaseUrl,
        useCodexConfig: input.providerMode === "default",
        model: input.model,
        size: input.size,
        quality: input.quality,
        background: input.background,
        outputFormat: input.outputFormat,
        outputDir: input.outputDir.trim() || undefined,
        stream: input.streaming,
      });
      setLastResult(result);
      setHistory((current) => {
        const next = [
          {
            ...result,
            prompt: input.prompt.trim(),
            effectivePrompt: input.effectivePrompt,
            providerMode: input.providerMode,
            baseUrl: requestBaseUrl || input.effectiveBaseUrl,
            size: input.size,
            quality: input.quality,
            background: input.background,
            outputFormat: input.outputFormat,
            generated_ms: Date.now(),
          },
          ...current.filter((item) => item.path !== result.path),
        ].slice(0, maxStoredTextToImageHistory);
        persistTextToImageHistory(next);
        return next;
      });
      reportTask({
        title: "文生图",
        stage: "生成完成",
        detail: `${result.file_name} · ${input.size}`,
        progress: 100,
        status: "success",
      });
      toast.success("图片已生成");
    } catch (error) {
      reportTask({
        title: "文生图",
        stage: "生成失败",
        detail: String(error),
        progress: 100,
        status: "error",
      });
      toast.error("生成失败: " + error);
    } finally {
      setGenerating(false);
      clearTaskSoon();
    }
  }

  return {
    generating,
    lastResult,
    setLastResult,
    history,
    clearHistory: () => {
      persistTextToImageHistory([]);
      setHistory([]);
    },
    generate,
  };
}
