import { afterEach, describe, expect, it, vi } from "vitest";
import { historyStorageKey, storageKey, stylePresets } from "./options";
import type { StylePresetId } from "./types";
import {
  buildPrompt,
  formatCreatedTime,
  formatImageEndpoint,
  loadStoredConfig,
  loadTextToImageHistory,
  maxStoredTextToImageHistory,
  persistTextToImageHistory,
} from "./utils";

const imageEndpointCases: Array<[string, string]> = [
  ["", ""],
  ["   ", ""],
  ["https://api.example.com", "https://api.example.com/v1/images/generations"],
  [" https://api.example.com/ ", "https://api.example.com/v1/images/generations"],
  ["https://api.example.com/v1", "https://api.example.com/v1/images/generations"],
  ["https://api.example.com/v1/images/generations", "https://api.example.com/v1/images/generations"],
];

function stubLocalStorage(initial: Record<string, string>) {
  const store = new Map(Object.entries(initial));
  const storage = {
    get length() {
      return store.size;
    },
    clear: vi.fn(() => store.clear()),
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    key: vi.fn((index: number) => Array.from(store.keys())[index] ?? null),
    removeItem: vi.fn((key: string) => store.delete(key)),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, value);
    }),
  } satisfies Storage;

  vi.stubGlobal("localStorage", storage);
  return storage;
}

describe("textToImage utils", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("loadStoredConfig", () => {
    it("returns stored object config", () => {
      stubLocalStorage({
        [storageKey]: JSON.stringify({
          providerMode: "default",
          ratio: "wide",
          streaming: true,
        }),
      });

      expect(loadStoredConfig()).toEqual({
        providerMode: "default",
        ratio: "wide",
        streaming: true,
      });
    });

    it("migrates the old codex provider mode to default", () => {
      stubLocalStorage({
        [storageKey]: JSON.stringify({
          providerMode: "codex",
          baseUrl: "https://relay.example.com",
        }),
      });

      expect(loadStoredConfig()).toMatchObject({
        providerMode: "default",
        baseUrl: "https://relay.example.com",
      });
    });

    it("falls back to an empty config for missing, invalid, or non-object values", () => {
      stubLocalStorage({});
      expect(loadStoredConfig()).toEqual({});

      stubLocalStorage({ [storageKey]: "{bad-json" });
      expect(loadStoredConfig()).toEqual({});

      stubLocalStorage({ [storageKey]: JSON.stringify("official") });
      expect(loadStoredConfig()).toEqual({});
    });
  });

  describe("buildPrompt", () => {
    it("trims user text and appends the selected preset prompt", () => {
      const photoPreset = stylePresets.find((preset) => preset.id === "photo");

      expect(buildPrompt("  A glass teapot on a walnut table  ", "photo")).toBe(
        `A glass teapot on a walnut table\n\n${photoPreset?.prompt}`
      );
    });

    it("omits empty prompt segments and falls back to the first preset", () => {
      expect(buildPrompt("  A clean app icon  ", "none")).toBe("A clean app icon");
      expect(buildPrompt("  ", "missing" as StylePresetId)).toBe("");
    });
  });

  describe("text-to-image history persistence", () => {
    it("loads valid entries and filters invalid data", () => {
      stubLocalStorage({
        [historyStorageKey]: JSON.stringify([
          {
            path: "/tmp/a.png",
            file_name: "a.png",
            mime_type: "image/png",
            size_bytes: 123,
            created_ms: 1000,
            model: "gpt-image-2",
            prompt: "blue circle",
          },
          { path: "" },
        ]),
      });

      expect(loadTextToImageHistory()).toHaveLength(1);
      expect(loadTextToImageHistory()[0].path).toBe("/tmp/a.png");
    });

    it("persists at most the configured history size", () => {
      const storage = stubLocalStorage({});
      const entries = Array.from({ length: maxStoredTextToImageHistory + 3 }, (_, index) => ({
        path: `/tmp/${index}.png`,
        file_name: `${index}.png`,
        mime_type: "image/png",
        size_bytes: 123,
        created_ms: index,
        model: "gpt-image-2",
        prompt: `prompt ${index}`,
      }));

      persistTextToImageHistory(entries);

      const saved = JSON.parse(storage.getItem(historyStorageKey) || "[]");
      expect(saved).toHaveLength(maxStoredTextToImageHistory);
    });
  });

  describe("formatCreatedTime", () => {
    it("keeps empty timestamps blank and formats non-empty timestamps", () => {
      expect(formatCreatedTime(0)).toBe("");
      expect(formatCreatedTime(Date.UTC(2025, 0, 2, 3, 4, 5))).not.toBe("");
    });
  });

  describe("formatImageEndpoint", () => {
    it.each(imageEndpointCases)("formats %j as %j", (input, expected) => {
      expect(formatImageEndpoint(input)).toBe(expected);
    });
  });
});
