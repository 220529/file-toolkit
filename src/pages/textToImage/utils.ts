import { storageKey, stylePresets } from "./options";
import type { StoredTextToImageConfig, StylePresetId } from "./types";

export function loadStoredConfig(): StoredTextToImageConfig {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function buildPrompt(prompt: string, presetId: StylePresetId) {
  const preset = stylePresets.find((item) => item.id === presetId) ?? stylePresets[0];
  return [prompt.trim(), preset.prompt].filter(Boolean).join("\n\n");
}

export function formatCreatedTime(ms: number) {
  if (!ms) return "";
  return new Date(ms).toLocaleString();
}

export function formatImageEndpoint(baseUrl: string) {
  const trimmed = baseUrl.trim().replace(/\/$/, "");
  if (!trimmed) return "";
  if (trimmed.endsWith("/images/generations")) return trimmed;
  if (trimmed.endsWith("/v1")) return `${trimmed}/images/generations`;
  return `${trimmed}/v1/images/generations`;
}
