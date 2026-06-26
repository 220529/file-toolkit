import { useEffect, useMemo, useState } from "react";
import { getImageGenerationConfig } from "../../api/tauri";
import { storageKey } from "./options";
import { loadStoredConfig } from "./utils";
import type { StoredTextToImageConfig } from "./types";

interface ServiceConfig {
  hasEnvKey: boolean;
  hasCodexKey: boolean;
  codexBaseUrl: string;
  codexProvider: string;
  codexHome: string;
  defaultOutputDir: string;
}

const emptyServiceConfig: ServiceConfig = {
  hasEnvKey: false,
  hasCodexKey: false,
  codexBaseUrl: "",
  codexProvider: "",
  codexHome: "",
  defaultOutputDir: "",
};

export function useStoredTextToImageConfig() {
  return useMemo(loadStoredConfig, []);
}

export function useImageGenerationServiceConfig(
  active: boolean,
  onCodexBaseUrl?: (baseUrl: string) => void
) {
  const [config, setConfig] = useState<ServiceConfig>(emptyServiceConfig);

  useEffect(() => {
    if (!active) return;

    getImageGenerationConfig()
      .then((nextConfig) => {
        setConfig({
          hasEnvKey: nextConfig.has_env_key,
          hasCodexKey: nextConfig.has_codex_key,
          codexBaseUrl: nextConfig.codex_base_url || "",
          codexProvider: nextConfig.codex_provider || "",
          codexHome: nextConfig.codex_home || "",
          defaultOutputDir: nextConfig.default_output_dir,
        });
        if (nextConfig.codex_base_url) {
          onCodexBaseUrl?.(nextConfig.codex_base_url);
        }
      })
      .catch(() => {
        setConfig((current) => ({
          ...current,
          hasEnvKey: false,
          hasCodexKey: false,
        }));
      });
  }, [active, onCodexBaseUrl]);

  return config;
}

export function usePersistTextToImageConfig(config: StoredTextToImageConfig) {
  const {
    background,
    baseUrl,
    model,
    outputDir,
    outputFormat,
    providerMode,
    quality,
    ratio,
    streaming,
    stylePreset,
  } = config;

  useEffect(() => {
    const nextConfig: StoredTextToImageConfig = {
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
    };

    try {
      localStorage.setItem(storageKey, JSON.stringify(nextConfig));
    } catch {
      // Ignore local config write failures; generation does not depend on persistence.
    }
  }, [background, baseUrl, model, outputDir, outputFormat, providerMode, quality, ratio, streaming, stylePreset]);
}
