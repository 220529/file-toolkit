import { historyStorageKey, storageKey, stylePresets } from "./options";
import type {
  StoredTextToImageConfig,
  StylePresetId,
  TextToImageHistoryEntry,
} from "./types";

export const maxStoredTextToImageHistory = 20;

export function loadStoredConfig(): StoredTextToImageConfig {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return {
      ...parsed,
      providerMode: parsed.providerMode === "codex" ? "default" : parsed.providerMode,
    };
  } catch {
    return {};
  }
}

export function loadTextToImageHistory(): TextToImageHistoryEntry[] {
  try {
    const raw = localStorage.getItem(historyStorageKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isTextToImageHistoryEntry).slice(0, maxStoredTextToImageHistory);
  } catch {
    return [];
  }
}

export function persistTextToImageHistory(history: TextToImageHistoryEntry[]) {
  try {
    localStorage.setItem(
      historyStorageKey,
      JSON.stringify(history.filter(isTextToImageHistoryEntry).slice(0, maxStoredTextToImageHistory))
    );
  } catch {
    // Ignore persistence failures; generated files remain on disk.
  }
}

function isTextToImageHistoryEntry(value: unknown): value is TextToImageHistoryEntry {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<TextToImageHistoryEntry>;
  return (
    typeof item.path === "string" &&
    item.path.length > 0 &&
    typeof item.file_name === "string" &&
    typeof item.mime_type === "string" &&
    typeof item.size_bytes === "number" &&
    typeof item.created_ms === "number" &&
    typeof item.model === "string" &&
    typeof item.prompt === "string"
  );
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
