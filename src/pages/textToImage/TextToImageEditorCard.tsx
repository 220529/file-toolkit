import type {
  ImageGenerationTestResult,
  ImageBackground,
  ImageModel,
  ImageOutputFormat,
  ImageQuality,
} from "../../api/tauri";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Icon } from "../../components/ui/icon";
import { Input } from "../../components/ui/input";
import { cn } from "../../utils/cn";
import {
  backgroundOptions,
  examplePrompts,
  formatOptions,
  modelOptions,
  officialBaseUrl,
  qualityOptions,
  ratioOptions,
  stylePresets,
} from "./options";
import type { ProviderMode, RatioId, StylePresetId } from "./types";
import { formatImageEndpoint } from "./utils";

interface TextToImageEditorCardProps {
  prompt: string;
  promptLength: number;
  apiKey: string;
  providerMode: ProviderMode;
  baseUrl: string;
  model: ImageModel;
  ratio: RatioId;
  quality: ImageQuality;
  background: ImageBackground;
  outputFormat: ImageOutputFormat;
  outputDir: string;
  stylePreset: StylePresetId;
  streaming: boolean;
  generating: boolean;
  testingConnection: boolean;
  testResult: ImageGenerationTestResult | null;
  canGenerate: boolean;
  hasCredential: boolean;
  hasEnvKey: boolean;
  hasCodexKey: boolean;
  codexBaseUrl: string;
  codexProvider: string;
  codexHome: string;
  defaultOutputDir: string;
  effectiveBaseUrl: string;
  selectedSize: string;
  onPromptChange: (value: string) => void;
  onApiKeyChange: (value: string) => void;
  onProviderModeChange: (value: ProviderMode) => void;
  onBaseUrlChange: (value: string) => void;
  onModelChange: (value: ImageModel) => void;
  onRatioChange: (value: RatioId) => void;
  onQualityChange: (value: ImageQuality) => void;
  onBackgroundChange: (value: ImageBackground) => void;
  onOutputFormatChange: (value: ImageOutputFormat) => void;
  onOutputDirChange: (value: string) => void;
  onStylePresetChange: (value: StylePresetId) => void;
  onStreamingChange: (value: boolean) => void;
  onChooseOutputDir: () => void;
  onTestConnection: () => void;
  onGenerate: () => void;
}

export function TextToImageEditorCard({
  prompt,
  promptLength,
  apiKey,
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
  generating,
  testingConnection,
  testResult,
  canGenerate,
  hasCredential,
  hasEnvKey,
  hasCodexKey,
  codexBaseUrl,
  codexProvider,
  codexHome,
  defaultOutputDir,
  effectiveBaseUrl,
  selectedSize,
  onPromptChange,
  onApiKeyChange,
  onProviderModeChange,
  onBaseUrlChange,
  onModelChange,
  onRatioChange,
  onQualityChange,
  onBackgroundChange,
  onOutputFormatChange,
  onOutputDirChange,
  onStylePresetChange,
  onStreamingChange,
  onChooseOutputDir,
  onTestConnection,
  onGenerate,
}: TextToImageEditorCardProps) {
  return (
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
            <span>{selectedSize}</span>
            <span>{outputFormat.toUpperCase()}</span>
          </div>
        </div>
        <Button variant="primary" onClick={onGenerate} disabled={!canGenerate}>
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
            onChange={(event) => onPromptChange(event.target.value)}
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
                onClick={() => onPromptChange(item)}
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
            <div className="flex items-center gap-2">
              {providerMode === "default" && codexProvider && <Badge tone="info">{codexProvider}</Badge>}
              <Button
                variant="secondary"
                size="sm"
                onClick={onTestConnection}
                disabled={testingConnection || !model.trim()}
              >
                <Icon name="check" size={14} />
                {testingConnection ? "测试中" : "测试连接"}
              </Button>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <button
              type="button"
              onClick={() => onProviderModeChange("default")}
              className={cn(
                "h-10 rounded-[8px] border px-2 text-xs font-medium transition",
                providerMode === "default"
                  ? "border-blue-200 bg-white text-[var(--brand-700)] ring-1 ring-blue-100"
                  : "border-slate-200 bg-white text-slate-600 hover:bg-slate-100"
              )}
            >
              默认配置
            </button>
            <button
              type="button"
              onClick={() => onProviderModeChange("custom")}
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
              onClick={() => onProviderModeChange("official")}
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
                value={providerMode === "official" ? officialBaseUrl : baseUrl}
                onChange={(event) => onBaseUrlChange(event.target.value)}
                disabled={providerMode === "official"}
                placeholder="https://your-relay.example.com"
              />
            </div>
            <div className="space-y-2">
              <label className="text-[11px] font-medium text-slate-500">API Key</label>
              <Input
                value={apiKey}
                onChange={(event) => onApiKeyChange(event.target.value)}
                type="password"
                autoComplete="off"
                placeholder={
                  providerMode === "default" && hasCodexKey
                    ? "留空使用默认 Key，可临时覆盖"
                    : hasEnvKey
                      ? "使用 OPENAI_API_KEY"
                      : "本次输入，不保存"
                }
              />
            </div>
          </div>
          {providerMode === "default" && (
            <div className="truncate text-[11px] text-slate-500">
              {codexBaseUrl
                ? `默认读取 ${codexHome || "Codex"}，当前地址和 Key 均可修改，调用时会自动补齐 /v1/images/generations`
                : "未找到默认服务地址，可直接填写 Base URL 和 API Key"}
            </div>
          )}
          {testResult && (
            <div
              className={cn(
                "rounded-[8px] border px-3 py-2 text-xs",
                testResult.ok
                  ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                  : "border-amber-200 bg-amber-50 text-amber-900"
              )}
            >
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={testResult.ok ? "success" : "warning"}>
                  {testResult.ok ? "自检通过" : "需要处理"}
                </Badge>
                <span className="font-medium">{testResult.message}</span>
                {testResult.elapsed_ms > 0 && (
                  <span className="text-current/70">{Math.round(testResult.elapsed_ms / 1000)}s</span>
                )}
              </div>
              <div className="mt-1 truncate text-current/70">{testResult.endpoint}</div>
              {testResult.image_models.length > 0 && (
                <div className="mt-1 truncate text-current/70">
                  图片模型 {testResult.image_models.slice(0, 4).join(" / ")}
                  {testResult.image_models.length > 4 ? ` 等 ${testResult.image_models.length} 个` : ""}
                </div>
              )}
              {testResult.detail && (
                <div className="mt-1 line-clamp-2 text-current/80">{testResult.detail}</div>
              )}
            </div>
          )}
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-2">
            <label className="text-xs font-semibold text-slate-700">模型</label>
            <Input
              value={model}
              onChange={(event) => onModelChange(event.target.value)}
              placeholder="gpt-image-2"
            />
            <div className="flex flex-wrap gap-1.5">
              {modelOptions.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  onClick={() => onModelChange(item.value)}
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
            onClick={() => onStreamingChange(!streaming)}
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
                onClick={() => onStylePresetChange(item.id)}
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
                  onClick={() => onRatioChange(item.id)}
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
                  onClick={() => onQualityChange(item.value)}
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
                    onClick={() => !disabled && onBackgroundChange(item.value)}
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
                  onClick={() => onOutputFormatChange(item.value)}
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
              onChange={(event) => onOutputDirChange(event.target.value)}
              placeholder={defaultOutputDir || "默认应用数据目录"}
            />
            <Button variant="secondary" onClick={onChooseOutputDir}>
              <Icon name="folderOpen" size={15} />
              选择
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
