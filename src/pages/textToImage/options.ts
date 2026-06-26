import type {
  ImageBackground,
  ImageModel,
  ImageOutputFormat,
  ImageQuality,
  ImageSize,
} from "../../api/tauri";
import type { RatioId, StylePresetId } from "./types";

export const officialBaseUrl = "https://api.openai.com";
export const storageKey = "xwm.textToImage.config.v1";

export const modelOptions: Array<{ value: ImageModel; label: string; badge?: string }> = [
  { value: "gpt-image-2", label: "GPT Image 2", badge: "默认" },
  { value: "gpt-image-1.5", label: "GPT Image 1.5" },
  { value: "gpt-image-1-mini", label: "GPT Image Mini" },
  { value: "gpt-image-1", label: "GPT Image 1" },
];

export const ratioOptions: Array<{ id: RatioId; label: string; size: ImageSize; hint: string }> = [
  { id: "square", label: "1:1", size: "1024x1024", hint: "方图" },
  { id: "wide", label: "16:9", size: "1536x1024", hint: "横图" },
  { id: "portrait", label: "9:16", size: "1024x1536", hint: "竖图" },
];

export const qualityOptions: Array<{ value: ImageQuality; label: string; hint: string }> = [
  { value: "low", label: "快速", hint: "低" },
  { value: "medium", label: "均衡", hint: "中" },
  { value: "high", label: "精细", hint: "高" },
];

export const formatOptions: Array<{ value: ImageOutputFormat; label: string }> = [
  { value: "png", label: "PNG" },
  { value: "jpeg", label: "JPG" },
  { value: "webp", label: "WebP" },
];

export const backgroundOptions: Array<{ value: ImageBackground; label: string }> = [
  { value: "auto", label: "自动背景" },
  { value: "transparent", label: "透明背景" },
];

export const stylePresets: Array<{ id: StylePresetId; label: string; prompt: string }> = [
  { id: "none", label: "原始", prompt: "" },
  {
    id: "photo",
    label: "写实",
    prompt: "Style: photorealistic, natural lighting, crisp details, realistic materials.",
  },
  {
    id: "illustration",
    label: "插画",
    prompt: "Style: refined digital illustration, warm composition, polished color and light.",
  },
  {
    id: "product",
    label: "产品图",
    prompt: "Style: clean product image, accurate shape, studio lighting, minimal background.",
  },
  {
    id: "poster",
    label: "海报",
    prompt: "Style: cinematic poster composition, strong focal point, layered atmosphere.",
  },
  {
    id: "icon",
    label: "图标",
    prompt: "Style: centered app icon asset, simple silhouette, clear edges, no readable text.",
  },
];

export const examplePrompts = [
  "傍晚的魔法书店，古老橡树根部的小书店，暖黄烛光，森林暮霭，奇幻插画",
  "一组极简文件整理工具图标，白底，蓝绿色点缀，干净现代",
  "桌面上的复古相机和咖啡，窗边自然光，写实摄影",
];
