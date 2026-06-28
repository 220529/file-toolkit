import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ImageBackground,
  ImageModel,
  ImageOutputFormat,
  ImageQuality,
} from "../../api/tauri";
import { officialBaseUrl, ratioOptions } from "./options";
import type { ProviderMode, RatioId, StylePresetId } from "./types";
import { buildPrompt } from "./utils";
import {
  useImageGenerationServiceConfig,
  usePersistTextToImageConfig,
  useStoredTextToImageConfig,
} from "./useTextToImageSettings";

export function useTextToImageForm(active: boolean) {
  const storedConfig = useStoredTextToImageConfig();
  const [prompt, setPrompt] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [providerMode, setProviderMode] = useState<ProviderMode>(storedConfig.providerMode || "default");
  const [baseUrl, setBaseUrl] = useState(storedConfig.baseUrl || "");
  const [model, setModel] = useState<ImageModel>(storedConfig.model || "gpt-image-2");
  const [ratio, setRatio] = useState<RatioId>(storedConfig.ratio || "square");
  const [quality, setQuality] = useState<ImageQuality>(storedConfig.quality || "medium");
  const [background, setBackground] = useState<ImageBackground>(storedConfig.background || "auto");
  const [outputFormat, setOutputFormat] = useState<ImageOutputFormat>(storedConfig.outputFormat || "png");
  const [outputDir, setOutputDir] = useState(storedConfig.outputDir || "");
  const [stylePreset, setStylePreset] = useState<StylePresetId>(storedConfig.stylePreset || "illustration");
  const [streaming, setStreaming] = useState(storedConfig.streaming ?? true);

  const applyCodexBaseUrl = useCallback((nextBaseUrl: string) => {
    setBaseUrl((current) => current || nextBaseUrl);
  }, []);
  const serviceConfig = useImageGenerationServiceConfig(active, applyCodexBaseUrl);

  const selectedRatio = ratioOptions.find((item) => item.id === ratio) ?? ratioOptions[0];
  const effectivePrompt = useMemo(() => buildPrompt(prompt, stylePreset), [prompt, stylePreset]);
  const effectiveBaseUrl = providerMode === "official" ? officialBaseUrl : baseUrl.trim();
  const hasCredential = Boolean(
    apiKey.trim() || serviceConfig.hasEnvKey || (providerMode === "default" && serviceConfig.hasCodexKey)
  );
  const promptLength = prompt.trim().length;

  useEffect(() => {
    if (model === "gpt-image-2" && background === "transparent") {
      setBackground("auto");
    }
  }, [background, model]);

  usePersistTextToImageConfig({
    providerMode,
    baseUrl,
    model,
    ratio,
    quality,
    background,
    outputFormat,
    outputDir,
    stylePreset,
    streaming,
  });

  return {
    prompt,
    setPrompt,
    promptLength,
    apiKey,
    setApiKey,
    providerMode,
    setProviderMode,
    baseUrl,
    setBaseUrl,
    model,
    setModel,
    ratio,
    setRatio,
    quality,
    setQuality,
    background,
    setBackground,
    outputFormat,
    setOutputFormat,
    outputDir,
    setOutputDir,
    stylePreset,
    setStylePreset,
    streaming,
    setStreaming,
    selectedRatio,
    effectivePrompt,
    effectiveBaseUrl,
    hasCredential,
    ...serviceConfig,
  };
}
