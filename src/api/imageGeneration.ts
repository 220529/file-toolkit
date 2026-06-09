import { invoke } from "@tauri-apps/api/core";

export type ImageModel = string;
export type ImageSize = "1024x1024" | "1536x1024" | "1024x1536";
export type ImageQuality = "low" | "medium" | "high";
export type ImageBackground = "auto" | "transparent";
export type ImageOutputFormat = "png" | "jpeg" | "webp";

export interface ImageGenerationConfig {
  has_env_key: boolean;
  has_codex_key: boolean;
  codex_base_url?: string | null;
  codex_provider?: string | null;
  codex_home?: string | null;
  default_output_dir: string;
}

export interface GenerateImageRequest {
  prompt: string;
  apiKey?: string;
  baseUrl?: string;
  useCodexConfig?: boolean;
  model: ImageModel;
  size: ImageSize;
  quality: ImageQuality;
  background: ImageBackground;
  outputFormat: ImageOutputFormat;
  outputDir?: string;
  stream?: boolean;
}

export interface GeneratedImage {
  path: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  created_ms: number;
  model: string;
  revised_prompt?: string | null;
}

export function getImageGenerationConfig() {
  return invoke<ImageGenerationConfig>("get_image_generation_config");
}

export function generateImage(request: GenerateImageRequest) {
  return invoke<GeneratedImage>("generate_image", { request });
}
