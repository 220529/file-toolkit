import { open } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import {
  testImageGeneration,
  type ImageGenerationTestResult,
} from "../api/tauri";
import { useFileActions } from "../hooks/useFileActions";
import { TextToImageEditorCard } from "./textToImage/TextToImageEditorCard";
import { TextToImageResultCard } from "./textToImage/TextToImageResultCard";
import { useTextToImageForm } from "./textToImage/useTextToImageForm";
import { useTextToImageGeneration } from "./textToImage/useTextToImageGeneration";

interface Props {
  active: boolean;
}

export default function TextToImage({ active }: Props) {
  const { openFile, revealInDir } = useFileActions();
  const { generating, lastResult, setLastResult, history, clearHistory, generate } = useTextToImageGeneration();
  const [testingConnection, setTestingConnection] = useState(false);
  const [testResult, setTestResult] = useState<ImageGenerationTestResult | null>(null);
  const form = useTextToImageForm(active);
  const {
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
    hasEnvKey,
    hasCodexKey,
    codexBaseUrl,
    codexProvider,
    codexHome,
    defaultOutputDir,
  } = form;
  const canGenerate = prompt.trim().length > 0 && model.trim().length > 0 && !generating;

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

  async function testConnection() {
    if (testingConnection) return;
    setTestingConnection(true);
    setTestResult(null);
    try {
      const requestBaseUrl =
        providerMode === "default" || providerMode === "custom"
          ? baseUrl.trim() || undefined
          : undefined;
      const result = await testImageGeneration({
        apiKey: apiKey.trim() || undefined,
        baseUrl: requestBaseUrl,
        useCodexConfig: providerMode === "default",
        model,
      });
      setTestResult(result);
    } catch (error) {
      setTestResult({
        ok: false,
        endpoint: effectiveBaseUrl,
        models_endpoint: "",
        model,
        has_requested_model: false,
        image_models: [],
        elapsed_ms: 0,
        message: `连接测试失败: ${error}`,
      });
    } finally {
      setTestingConnection(false);
    }
  }

  return (
    <div className="mx-auto max-w-[1320px] space-y-3">
      <div className="grid min-h-[calc(100vh-150px)] gap-3 lg:grid-cols-[minmax(420px,0.95fr)_minmax(420px,1.05fr)]">
        <TextToImageEditorCard
          prompt={prompt}
          promptLength={promptLength}
          apiKey={apiKey}
          providerMode={providerMode}
          baseUrl={baseUrl}
          model={model}
          ratio={ratio}
          quality={quality}
          background={background}
          outputFormat={outputFormat}
          outputDir={outputDir}
          stylePreset={stylePreset}
          streaming={streaming}
          generating={generating}
          testingConnection={testingConnection}
          testResult={testResult}
          canGenerate={canGenerate}
          hasCredential={hasCredential}
          hasEnvKey={hasEnvKey}
          hasCodexKey={hasCodexKey}
          codexBaseUrl={codexBaseUrl}
          codexProvider={codexProvider}
          codexHome={codexHome}
          defaultOutputDir={defaultOutputDir}
          effectiveBaseUrl={effectiveBaseUrl}
          selectedSize={selectedRatio.size}
          onPromptChange={setPrompt}
          onApiKeyChange={setApiKey}
          onProviderModeChange={setProviderMode}
          onBaseUrlChange={setBaseUrl}
          onModelChange={setModel}
          onRatioChange={setRatio}
          onQualityChange={setQuality}
          onBackgroundChange={setBackground}
          onOutputFormatChange={setOutputFormat}
          onOutputDirChange={setOutputDir}
          onStylePresetChange={setStylePreset}
          onStreamingChange={setStreaming}
          onChooseOutputDir={() => void chooseOutputDir()}
          onTestConnection={() => void testConnection()}
          onGenerate={() => void generate({
            prompt,
            effectivePrompt,
            apiKey,
            providerMode,
            baseUrl,
            effectiveBaseUrl,
            model,
            size: selectedRatio.size,
            quality,
            background,
            outputFormat,
            outputDir,
            streaming,
          })}
        />

        <TextToImageResultCard
          generating={generating}
          lastResult={lastResult}
          history={history}
          onOpenFile={openFile}
          onRevealInDir={revealInDir}
          onSelectHistory={setLastResult}
          onClearHistory={clearHistory}
        />
      </div>
    </div>
  );
}
