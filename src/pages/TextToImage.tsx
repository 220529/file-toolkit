import { useEffect, useMemo, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  generateImage,
  getImageGenerationConfig,
  type GeneratedImage,
  type ImageBackground,
  type ImageModel,
  type ImageOutputFormat,
  type ImageQuality,
  type ImageSize,
} from "../api/tauri";
import { useTaskReporter } from "../components/TaskCenter";
import { useToast } from "../components/Toast";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "../components/ui/card";
import { Icon } from "../components/ui/icon";
import { Input } from "../components/ui/input";
import { Tooltip } from "../components/ui/tooltip";
import { useFileActions } from "../hooks/useFileActions";
import { cn } from "../utils/cn";
import { formatSize } from "../utils/format";
import { createTaskId } from "../utils/id";
import { getBaseName } from "../utils/path";

interface Props {
  active: boolean;
}

type StylePresetId = "none" | "photo" | "illustration" | "product" | "poster" | "icon";
type RatioId = "square" | "wide" | "portrait";
type ProviderMode = "codex" | "custom" | "official";

const officialBaseUrl = "https://api.openai.com";
const storageKey = "xwm.textToImage.config.v1";

const modelOptions: Array<{ value: ImageModel; label: string; badge?: string }> = [
  { value: "gpt-image-2", label: "GPT Image 2", badge: "默认" },
  { value: "gpt-image-1.5", label: "GPT Image 1.5" },
  { value: "gpt-image-1-mini", label: "GPT Image Mini" },
  { value: "gpt-image-1", label: "GPT Image 1" },
];

const ratioOptions: Array<{ id: RatioId; label: string; size: ImageSize; hint: string }> = [
  { id: "square", label: "1:1", size: "1024x1024", hint: "方图" },
  { id: "wide", label: "16:9", size: "1536x1024", hint: "横图" },
  { id: "portrait", label: "9:16", size: "1024x1536", hint: "竖图" },
];

const qualityOptions: Array<{ value: ImageQuality; label: string; hint: string }> = [
  { value: "low", label: "快速", hint: "低" },
  { value: "medium", label: "均衡", hint: "中" },
  { value: "high", label: "精细", hint: "高" },
];

const formatOptions: Array<{ value: ImageOutputFormat; label: string }> = [
  { value: "png", label: "PNG" },
  { value: "jpeg", label: "JPG" },
  { value: "webp", label: "WebP" },
];

const backgroundOptions: Array<{ value: ImageBackground; label: string }> = [
  { value: "auto", label: "自动背景" },
  { value: "transparent", label: "透明背景" },
];

const stylePresets: Array<{ id: StylePresetId; label: string; prompt: string }> = [
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

const examplePrompts = [
  "傍晚的魔法书店，古老橡树根部的小书店，暖黄烛光，森林暮霭，奇幻插画",
  "一组极简文件整理工具图标，白底，蓝绿色点缀，干净现代",
  "桌面上的复古相机和咖啡，窗边自然光，写实摄影",
];

interface StoredTextToImageConfig {
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

function loadStoredConfig(): StoredTextToImageConfig {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function buildPrompt(prompt: string, presetId: StylePresetId) {
  const preset = stylePresets.find((item) => item.id === presetId) ?? stylePresets[0];
  return [prompt.trim(), preset.prompt].filter(Boolean).join("\n\n");
}

function formatCreatedTime(ms: number) {
  if (!ms) return "";
  return new Date(ms).toLocaleString();
}

function formatImageEndpoint(baseUrl: string) {
  const trimmed = baseUrl.trim().replace(/\/$/, "");
  if (!trimmed) return "";
  if (trimmed.endsWith("/images/generations")) return trimmed;
  if (trimmed.endsWith("/v1")) return `${trimmed}/images/generations`;
  return `${trimmed}/v1/images/generations`;
}

export default function TextToImage({ active }: Props) {
  const toast = useToast();
  const { openFile, revealInDir } = useFileActions();
  const taskId = useMemo(() => createTaskId("text-image"), []);
  const { reportTask, clearTask } = useTaskReporter(taskId);
  const storedConfig = useMemo(loadStoredConfig, []);
  const [prompt, setPrompt] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [providerMode, setProviderMode] = useState<ProviderMode>(storedConfig.providerMode || "codex");
  const [baseUrl, setBaseUrl] = useState(storedConfig.baseUrl || "");
  const [model, setModel] = useState<ImageModel>(storedConfig.model || "gpt-image-2");
  const [ratio, setRatio] = useState<RatioId>(storedConfig.ratio || "square");
  const [quality, setQuality] = useState<ImageQuality>(storedConfig.quality || "medium");
  const [background, setBackground] = useState<ImageBackground>(storedConfig.background || "auto");
  const [outputFormat, setOutputFormat] = useState<ImageOutputFormat>(storedConfig.outputFormat || "png");
  const [outputDir, setOutputDir] = useState(storedConfig.outputDir || "");
  const [stylePreset, setStylePreset] = useState<StylePresetId>(storedConfig.stylePreset || "illustration");
  const [streaming, setStreaming] = useState(storedConfig.streaming ?? true);
  const [generating, setGenerating] = useState(false);
  const [lastResult, setLastResult] = useState<GeneratedImage | null>(null);
  const [history, setHistory] = useState<Array<GeneratedImage & { prompt: string }>>([]);
  const [hasEnvKey, setHasEnvKey] = useState(false);
  const [hasCodexKey, setHasCodexKey] = useState(false);
  const [codexBaseUrl, setCodexBaseUrl] = useState("");
  const [codexProvider, setCodexProvider] = useState("");
  const [codexHome, setCodexHome] = useState("");
  const [defaultOutputDir, setDefaultOutputDir] = useState("");

  const selectedRatio = ratioOptions.find((item) => item.id === ratio) ?? ratioOptions[0];
  const effectivePrompt = useMemo(() => buildPrompt(prompt, stylePreset), [prompt, stylePreset]);
  const effectiveBaseUrl =
    providerMode === "official" ? officialBaseUrl : providerMode === "codex" ? codexBaseUrl : baseUrl.trim();
  const hasCredential = Boolean(apiKey.trim() || hasEnvKey || (providerMode === "codex" && hasCodexKey));
  const canGenerate = prompt.trim().length > 0 && model.trim().length > 0 && !generating;
  const promptLength = prompt.trim().length;
  const resultSrc = lastResult ? convertFileSrc(lastResult.path) : "";

  useEffect(() => {
    if (!active) return;

    getImageGenerationConfig()
      .then((config) => {
        setHasEnvKey(config.has_env_key);
        setHasCodexKey(config.has_codex_key);
        setCodexBaseUrl(config.codex_base_url || "");
        setCodexProvider(config.codex_provider || "");
        setCodexHome(config.codex_home || "");
        setDefaultOutputDir(config.default_output_dir);
        if (config.codex_base_url) {
          setBaseUrl((current) => current || config.codex_base_url || "");
        }
      })
      .catch(() => {
        setHasEnvKey(false);
        setHasCodexKey(false);
      });
  }, [active]);

  useEffect(() => {
    if (model === "gpt-image-2" && background === "transparent") {
      setBackground("auto");
    }
  }, [background, model]);

  useEffect(() => {
    const config: StoredTextToImageConfig = {
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
      localStorage.setItem(storageKey, JSON.stringify(config));
    } catch {
      // 忽略本地配置写入失败，生成功能不依赖它。
    }
  }, [background, baseUrl, model, outputDir, outputFormat, providerMode, quality, ratio, streaming, stylePreset]);

  async function chooseOutputDir() {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "选择文生图输出目录",
    });

    if (typeof selected === "string") {
      setOutputDir(selected);
    }
  }

  async function handleGenerate() {
    if (!prompt.trim()) {
      toast.warning("请输入提示词");
      return;
    }

    setGenerating(true);
    reportTask({
      title: "文生图",
      stage: "生成图片",
      detail: `${selectedRatio.size} · ${model} · ${effectiveBaseUrl || "默认服务"}`,
    });

    try {
      const requestBaseUrl =
        providerMode === "custom" ? baseUrl.trim() || undefined : providerMode === "official" ? officialBaseUrl : undefined;
      const result = await generateImage({
        prompt: effectivePrompt,
        apiKey: providerMode === "codex" ? undefined : apiKey.trim() || undefined,
        baseUrl: requestBaseUrl,
        useCodexConfig: providerMode === "codex",
        model,
        size: selectedRatio.size,
        quality,
        background,
        outputFormat,
        outputDir: outputDir.trim() || undefined,
        stream: streaming,
      });
      setLastResult(result);
      setHistory((current) => [{ ...result, prompt: prompt.trim() }, ...current].slice(0, 8));
      toast.success("图片已生成");
    } catch (e) {
      toast.error("生成失败: " + e);
    } finally {
      setGenerating(false);
      clearTask();
    }
  }

  return (
    <div className="mx-auto max-w-[1320px] space-y-3">
      <div className="grid min-h-[calc(100vh-150px)] gap-3 lg:grid-cols-[minmax(420px,0.95fr)_minmax(420px,1.05fr)]">
        <Card className="overflow-hidden">
          <CardHeader className="items-center">
            <div className="min-w-0">
              <CardTitle>创作台</CardTitle>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                <Badge tone={hasCredential ? "success" : "warning"}>
                  {hasCredential ? "Key 就绪" : "待配置 Key"}
                </Badge>
                <span className="max-w-[220px] truncate">{effectiveBaseUrl || "未配置服务"}</span>
                {streaming && <Badge tone="info">流式</Badge>}
                <span>{selectedRatio.size}</span>
                <span>{outputFormat.toUpperCase()}</span>
              </div>
            </div>
            <Button variant="primary" onClick={handleGenerate} disabled={!canGenerate}>
              <Icon name="magic" size={15} />
              {generating ? "生成中" : "生成图片"}
            </Button>
          </CardHeader>

          <CardContent className="space-y-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <label className="text-xs font-semibold text-slate-700">提示词</label>
                <span className={cn("text-[11px]", promptLength > 3600 ? "text-amber-600" : "text-slate-400")}>
                  {promptLength} / 4000
                </span>
              </div>
              <textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                className={cn(
                  "min-h-[168px] w-full resize-y rounded-[8px] border border-slate-300 bg-white px-3 py-3 text-sm leading-6 text-slate-900 outline-none transition-all",
                  "placeholder:text-slate-400 focus:border-[var(--brand-400)] focus:ring-[3px] focus:ring-[var(--brand-100)]"
                )}
                placeholder="描述画面、主体、风格、光线、构图"
                maxLength={4000}
              />
              <div className="flex flex-wrap gap-2">
                {examplePrompts.map((item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => setPrompt(item)}
                    className="rounded-[8px] border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs text-slate-600 transition hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700"
                  >
                    {item}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-3 rounded-[8px] border border-slate-200 bg-slate-50 p-3">
              <div className="flex items-center justify-between gap-3">
                <label className="text-xs font-semibold text-slate-700">服务配置</label>
                {providerMode === "codex" && codexProvider && <Badge tone="info">{codexProvider}</Badge>}
              </div>
              <div className="grid grid-cols-3 gap-2">
                <button
                  type="button"
                  onClick={() => setProviderMode("codex")}
                  className={cn(
                    "h-10 rounded-[8px] border px-2 text-xs font-medium transition",
                    providerMode === "codex"
                      ? "border-blue-200 bg-white text-[var(--brand-700)] ring-1 ring-blue-100"
                      : "border-slate-200 bg-white text-slate-600 hover:bg-slate-100"
                  )}
                >
                  Codex 配置
                </button>
                <button
                  type="button"
                  onClick={() => setProviderMode("custom")}
                  className={cn(
                    "h-10 rounded-[8px] border px-2 text-xs font-medium transition",
                    providerMode === "custom"
                      ? "border-blue-200 bg-white text-[var(--brand-700)] ring-1 ring-blue-100"
                      : "border-slate-200 bg-white text-slate-600 hover:bg-slate-100"
                  )}
                >
                  自定义中转
                </button>
                <button
                  type="button"
                  onClick={() => setProviderMode("official")}
                  className={cn(
                    "h-10 rounded-[8px] border px-2 text-xs font-medium transition",
                    providerMode === "official"
                      ? "border-blue-200 bg-white text-[var(--brand-700)] ring-1 ring-blue-100"
                      : "border-slate-200 bg-white text-slate-600 hover:bg-slate-100"
                  )}
                >
                  官方地址
                </button>
              </div>
              <div className="grid gap-3 md:grid-cols-[1fr_0.8fr]">
                <div className="space-y-2">
                  <label className="text-[11px] font-medium text-slate-500">Base URL</label>
                  <Input
                    value={providerMode === "official" ? officialBaseUrl : providerMode === "codex" ? codexBaseUrl : baseUrl}
                    onChange={(event) => setBaseUrl(event.target.value)}
                    disabled={providerMode !== "custom"}
                    placeholder="https://your-relay.example.com"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-[11px] font-medium text-slate-500">API Key</label>
                  <Input
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    type="password"
                    autoComplete="off"
                    disabled={providerMode === "codex" && hasCodexKey}
                    placeholder={
                      providerMode === "codex" && hasCodexKey
                        ? "使用 Codex auth"
                        : hasEnvKey
                        ? "使用 OPENAI_API_KEY"
                        : "本次输入，不保存"
                    }
                  />
                </div>
              </div>
              {providerMode === "codex" && (
                <div className="truncate text-[11px] text-slate-500">
                  {codexBaseUrl ? `读取 ${codexHome || "Codex"}，调用时会自动补齐 /v1/images/generations` : "未找到可用 Codex 服务地址"}
                </div>
              )}
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-2">
                <label className="text-xs font-semibold text-slate-700">模型</label>
                <Input
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  placeholder="gpt-image-2"
                />
                <div className="flex flex-wrap gap-1.5">
                  {modelOptions.map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      onClick={() => setModel(item.value)}
                      className={cn(
                        "rounded-[6px] border px-2 py-1 text-[11px] transition",
                        model === item.value
                          ? "border-blue-200 bg-blue-50 text-[var(--brand-700)]"
                          : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50"
                      )}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-xs font-semibold text-slate-700">当前接口</label>
                <div className="flex min-h-10 items-center rounded-[8px] border border-slate-200 bg-white px-3 text-xs text-slate-500">
                  <span className="truncate">{effectiveBaseUrl ? formatImageEndpoint(effectiveBaseUrl) : "未配置"}</span>
                </div>
              </div>
            </div>

            <label className="flex items-center justify-between gap-4 rounded-[8px] border border-slate-200 bg-white px-3 py-2.5">
              <span className="min-w-0">
                <span className="block text-xs font-semibold text-slate-700">流式返回</span>
                <span className="mt-0.5 block truncate text-[11px] text-slate-400">中转生成较慢时可避免 504 超时</span>
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={streaming}
                onClick={() => setStreaming((value) => !value)}
                className={cn(
                  "relative h-6 w-11 rounded-full transition",
                  streaming ? "bg-[var(--brand-600)]" : "bg-slate-300"
                )}
              >
                <span
                  className={cn(
                    "absolute top-1 h-4 w-4 rounded-full bg-white transition",
                    streaming ? "left-6" : "left-1"
                  )}
                />
              </button>
            </label>

            <div className="space-y-2">
              <label className="text-xs font-semibold text-slate-700">风格</label>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
                {stylePresets.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setStylePreset(item.id)}
                    className={cn(
                      "h-9 rounded-[8px] border px-2 text-xs font-medium transition",
                      stylePreset === item.id
                        ? "border-blue-200 bg-blue-50 text-[var(--brand-700)] ring-1 ring-blue-100"
                        : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                    )}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-2">
                <label className="text-xs font-semibold text-slate-700">比例</label>
                <div className="grid grid-cols-3 gap-2">
                  {ratioOptions.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setRatio(item.id)}
                      className={cn(
                        "h-12 rounded-[8px] border px-2 text-center transition",
                        ratio === item.id
                          ? "border-blue-200 bg-blue-50 text-[var(--brand-700)] ring-1 ring-blue-100"
                          : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                      )}
                    >
                      <div className="text-sm font-semibold leading-5">{item.label}</div>
                      <div className="text-[10px] leading-4 text-slate-400">{item.hint}</div>
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-xs font-semibold text-slate-700">质量</label>
                <div className="grid grid-cols-3 gap-2">
                  {qualityOptions.map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      onClick={() => setQuality(item.value)}
                      className={cn(
                        "h-12 rounded-[8px] border px-2 text-center transition",
                        quality === item.value
                          ? "border-teal-200 bg-teal-50 text-teal-700 ring-1 ring-teal-100"
                          : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                      )}
                    >
                      <div className="text-sm font-semibold leading-5">{item.label}</div>
                      <div className="text-[10px] leading-4 text-slate-400">{item.hint}</div>
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-2">
                <label className="text-xs font-semibold text-slate-700">背景</label>
                <div className="grid grid-cols-2 gap-2">
                  {backgroundOptions.map((item) => {
                    const disabled = item.value === "transparent" && model === "gpt-image-2";
                    return (
                      <button
                        key={item.value}
                        type="button"
                        onClick={() => !disabled && setBackground(item.value)}
                        disabled={disabled}
                        className={cn(
                          "h-10 rounded-[8px] border px-2 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-45",
                          background === item.value
                            ? "border-blue-200 bg-blue-50 text-[var(--brand-700)] ring-1 ring-blue-100"
                            : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                        )}
                      >
                        {item.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-xs font-semibold text-slate-700">格式</label>
                <div className="grid grid-cols-3 gap-2">
                  {formatOptions.map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      onClick={() => setOutputFormat(item.value)}
                      className={cn(
                        "h-10 rounded-[8px] border px-2 text-xs font-semibold transition",
                        outputFormat === item.value
                          ? "border-slate-300 bg-slate-900 text-white"
                          : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                      )}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-xs font-semibold text-slate-700">输出目录</label>
              <div className="flex gap-2">
                <Input
                  value={outputDir}
                  onChange={(event) => setOutputDir(event.target.value)}
                  placeholder={defaultOutputDir || "默认应用数据目录"}
                />
                <Button variant="secondary" onClick={chooseOutputDir}>
                  <Icon name="folderOpen" size={15} />
                  选择
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="flex min-h-[520px] flex-col overflow-hidden">
          <CardHeader className="items-center">
            <div className="min-w-0">
              <CardTitle>结果</CardTitle>
              <div className="mt-1 text-xs text-slate-500">
                {lastResult ? `${lastResult.file_name} · ${formatSize(lastResult.size_bytes)}` : "等待生成"}
              </div>
            </div>
            {lastResult && (
              <div className="flex items-center gap-2">
                <Tooltip content="打开图片">
                  <Button variant="secondary" size="icon" onClick={() => openFile(lastResult.path)} aria-label="打开图片">
                    <Icon name="image" size={16} />
                  </Button>
                </Tooltip>
                <Tooltip content="定位文件">
                  <Button variant="secondary" size="icon" onClick={() => revealInDir(lastResult.path)} aria-label="定位文件">
                    <Icon name="folderOpen" size={16} />
                  </Button>
                </Tooltip>
              </div>
            )}
          </CardHeader>

          <CardContent className="flex flex-1 flex-col gap-4">
            <div className="relative flex min-h-[360px] flex-1 items-center justify-center overflow-hidden rounded-[8px] border border-slate-200 bg-[linear-gradient(45deg,#f8fafc_25%,transparent_25%),linear-gradient(-45deg,#f8fafc_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#f8fafc_75%),linear-gradient(-45deg,transparent_75%,#f8fafc_75%)] bg-[length:20px_20px] bg-[position:0_0,0_10px,10px_-10px,-10px_0]">
              {generating ? (
                <div className="flex flex-col items-center gap-3 text-slate-500">
                  <div className="flex h-12 w-12 items-center justify-center rounded-[8px] border border-blue-100 bg-blue-50 text-[var(--brand-700)]">
                    <Icon name="magic" size={20} />
                  </div>
                  <div className="text-sm font-medium">生成中</div>
                </div>
              ) : lastResult ? (
                <img src={resultSrc} alt="生成结果" className="h-full max-h-[560px] w-full object-contain" />
              ) : (
                <div className="flex flex-col items-center gap-3 text-slate-400">
                  <div className="flex h-12 w-12 items-center justify-center rounded-[8px] border border-slate-200 bg-white">
                    <Icon name="image" size={20} />
                  </div>
                  <div className="text-sm font-medium">暂无图片</div>
                </div>
              )}
            </div>

            {lastResult && (
              <div className="grid gap-2 rounded-[8px] border border-slate-200 bg-slate-50 px-3 py-3 text-xs text-slate-600 md:grid-cols-2">
                <div className="truncate">
                  <span className="text-slate-400">模型</span> {lastResult.model}
                </div>
                <div className="truncate">
                  <span className="text-slate-400">时间</span> {formatCreatedTime(lastResult.created_ms)}
                </div>
                <div className="truncate md:col-span-2">
                  <span className="text-slate-400">路径</span> {lastResult.path}
                </div>
                {lastResult.revised_prompt && (
                  <div className="max-h-10 overflow-hidden leading-5 md:col-span-2">
                    <span className="text-slate-400">修订</span> {lastResult.revised_prompt}
                  </div>
                )}
              </div>
            )}
          </CardContent>

          <CardFooter className="block">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-xs font-semibold text-slate-700">最近产出</div>
              {history.length > 0 && (
                <button className="text-xs text-slate-500 hover:text-slate-900" onClick={() => setHistory([])}>
                  清空
                </button>
              )}
            </div>
            {history.length === 0 ? (
              <div className="rounded-[8px] border border-dashed border-slate-200 bg-white px-3 py-4 text-center text-xs text-slate-400">暂无记录</div>
            ) : (
              <div className="grid max-h-[180px] gap-2 overflow-auto pr-1">
                {history.map((item) => (
                  <button
                    key={item.path}
                    type="button"
                    onClick={() => setLastResult(item)}
                    className={cn(
                      "grid grid-cols-[52px_1fr_auto] items-center gap-3 rounded-[8px] border bg-white p-2 text-left transition hover:border-blue-200 hover:bg-blue-50/40",
                      lastResult?.path === item.path ? "border-blue-200 ring-1 ring-blue-100" : "border-slate-200"
                    )}
                  >
                    <img src={convertFileSrc(item.path)} alt="" className="h-12 w-12 rounded-[6px] object-cover" />
                    <div className="min-w-0">
                      <div className="truncate text-xs font-medium text-slate-800">{getBaseName(item.path)}</div>
                      <div className="mt-0.5 truncate text-[11px] text-slate-400">{item.prompt}</div>
                    </div>
                    <Badge>{item.mime_type.split("/")[1]?.toUpperCase()}</Badge>
                  </button>
                ))}
              </div>
            )}
          </CardFooter>
        </Card>
      </div>
    </div>
  );
}
