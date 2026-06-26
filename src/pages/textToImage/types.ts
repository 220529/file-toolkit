import type {
  GeneratedImage,
  ImageBackground,
  ImageOutputFormat,
  ImageQuality,
} from "../../api/tauri";

export type StylePresetId = "none" | "photo" | "illustration" | "product" | "poster" | "icon";
export type RatioId = "square" | "wide" | "portrait";
export type ProviderMode = "codex" | "custom" | "official";

export interface StoredTextToImageConfig {
  providerMode?: ProviderMode;
  baseUrl?: string;
  model?: string;
  ratio?: RatioId;
  quality?: ImageQuality;
  background?: ImageBackground;
  outputFormat?: ImageOutputFormat;
  outputDir?: string;
  stylePreset?: StylePresetId;
  streaming?: boolean;
}

export type TextToImageHistoryItem = GeneratedImage & { prompt: string };
