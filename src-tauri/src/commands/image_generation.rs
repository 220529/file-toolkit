use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::Local;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

use super::logger::{log_error, log_info};

const OPENAI_BASE_URL: &str = "https://api.openai.com";
const DEFAULT_MODEL: &str = "gpt-image-2";
const DEFAULT_SIZE: &str = "1024x1024";
const DEFAULT_QUALITY: &str = "medium";
const DEFAULT_OUTPUT_FORMAT: &str = "png";
const MAX_PROMPT_CHARS: usize = 4000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateImageRequest {
    pub prompt: String,
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    pub use_codex_config: Option<bool>,
    pub model: Option<String>,
    pub size: Option<String>,
    pub quality: Option<String>,
    pub background: Option<String>,
    pub output_format: Option<String>,
    pub output_dir: Option<String>,
    pub stream: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct GeneratedImage {
    pub path: String,
    pub file_name: String,
    pub mime_type: String,
    pub size_bytes: u64,
    pub created_ms: u64,
    pub model: String,
    pub revised_prompt: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ImageGenerationConfig {
    pub has_env_key: bool,
    pub has_codex_key: bool,
    pub codex_base_url: Option<String>,
    pub codex_provider: Option<String>,
    pub codex_home: Option<String>,
    pub default_output_dir: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestImageGenerationRequest {
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    pub use_codex_config: Option<bool>,
    pub model: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ImageGenerationTestResult {
    pub ok: bool,
    pub endpoint: String,
    pub models_endpoint: String,
    pub model: String,
    pub has_requested_model: bool,
    pub image_models: Vec<String>,
    pub models_status: Option<u16>,
    pub generation_status: Option<u16>,
    pub elapsed_ms: u64,
    pub message: String,
    pub detail: Option<String>,
}

struct CodexProviderConfig {
    codex_home: PathBuf,
    provider: String,
    base_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OpenAIImageResponse {
    data: Vec<OpenAIImageData>,
}

#[derive(Debug, Deserialize)]
struct OpenAIModelsResponse {
    data: Vec<OpenAIModelData>,
}

#[derive(Debug, Deserialize)]
struct OpenAIModelData {
    id: String,
}

#[derive(Debug, Deserialize)]
struct OpenAIImageData {
    b64_json: Option<String>,
    url: Option<String>,
    revised_prompt: Option<String>,
    output_format: Option<String>,
}

struct DecodedImagePayload {
    bytes: Vec<u8>,
    revised_prompt: Option<String>,
    output_format: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OpenAIErrorResponse {
    error: Option<OpenAIErrorBody>,
}

#[derive(Debug, Deserialize)]
struct OpenAIErrorBody {
    message: Option<String>,
    r#type: Option<String>,
    code: Option<Value>,
}

#[tauri::command]
pub fn get_image_generation_config(app: AppHandle) -> Result<ImageGenerationConfig, String> {
    let codex_config = read_codex_provider_config();

    Ok(ImageGenerationConfig {
        has_env_key: read_env_api_key().is_some(),
        has_codex_key: codex_config
            .as_ref()
            .and_then(|config| read_codex_api_key(&config.codex_home))
            .is_some(),
        codex_base_url: codex_config
            .as_ref()
            .and_then(|config| config.base_url.clone()),
        codex_provider: codex_config.as_ref().map(|config| config.provider.clone()),
        codex_home: codex_config
            .as_ref()
            .map(|config| config.codex_home.to_string_lossy().to_string()),
        default_output_dir: default_output_dir(&app)?.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub async fn generate_image(
    app: AppHandle,
    request: GenerateImageRequest,
) -> Result<GeneratedImage, String> {
    let prompt = normalize_prompt(&request.prompt)?;
    let codex_config = request
        .use_codex_config
        .unwrap_or(false)
        .then(read_codex_provider_config)
        .flatten();
    let api_key = resolve_api_key(request.api_key, codex_config.as_ref())?;
    let model = validate_model(request.model.as_deref().unwrap_or(DEFAULT_MODEL))?;
    let image_endpoint =
        resolve_image_endpoint(request.base_url.as_deref(), codex_config.as_ref())?;
    let size = validate_size(request.size.as_deref().unwrap_or(DEFAULT_SIZE))?;
    let quality = validate_quality(request.quality.as_deref().unwrap_or(DEFAULT_QUALITY))?;
    let output_format = validate_output_format(
        request
            .output_format
            .as_deref()
            .unwrap_or(DEFAULT_OUTPUT_FORMAT),
    )?;
    let background = validate_background(request.background.as_deref().unwrap_or("auto"))?;
    validate_model_background(&model, &background)?;
    let output_dir = resolve_output_dir(&app, request.output_dir.as_deref())?;
    let stream = request.stream.unwrap_or(false);

    log_info(&format!(
        "[文生图] 开始生成: model={}, size={}, quality={}, format={}, stream={}, output={}",
        model,
        size,
        quality,
        output_format,
        stream,
        output_dir.display()
    ));

    let mut payload = json!({
        "model": model,
        "prompt": prompt,
        "size": size,
        "quality": quality,
        "output_format": output_format,
        "n": 1
    });

    if stream {
        payload["stream"] = json!(true);
    }

    if background == "transparent" {
        payload["background"] = json!("transparent");
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|e| format!("初始化网络客户端失败: {}", e))?;

    let response = client
        .post(&image_endpoint)
        .bearer_auth(api_key)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("请求 OpenAI 失败: {}", e))?;

    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let body = response
        .text()
        .await
        .map_err(|e| format!("读取 OpenAI 响应失败: {}", e))?;

    if !status.is_success() {
        let message = extract_error_message(status.as_u16(), &body);
        log_error(&format!("[文生图] 生成失败: {}", message));
        return Err(message);
    }

    let decoded = decode_image_response(&client, &body, &content_type).await?;
    if decoded.bytes.is_empty() {
        return Err("OpenAI 返回了空图片数据".to_string());
    }

    fs::create_dir_all(&output_dir).map_err(|e| format!("创建输出目录失败: {}", e))?;
    let final_output_format = decoded
        .output_format
        .as_deref()
        .and_then(normalize_output_format_hint)
        .unwrap_or_else(|| output_format.clone());
    let extension = output_extension(&final_output_format);
    let created_ms = Local::now().timestamp_millis().max(0) as u64;
    let file_name = build_output_file_name(created_ms, &prompt, extension);
    let output_path = output_dir.join(&file_name);
    fs::write(&output_path, &decoded.bytes).map_err(|e| format!("写入图片失败: {}", e))?;
    let size_bytes = fs::metadata(&output_path)
        .map_err(|e| format!("读取输出图片信息失败: {}", e))?
        .len();

    log_info(&format!(
        "[文生图] 生成完成: {}, {} bytes",
        output_path.display(),
        size_bytes
    ));

    Ok(GeneratedImage {
        path: output_path.to_string_lossy().to_string(),
        file_name,
        mime_type: mime_type(&final_output_format).to_string(),
        size_bytes,
        created_ms,
        model,
        revised_prompt: decoded.revised_prompt,
    })
}

#[tauri::command]
pub async fn test_image_generation(
    request: TestImageGenerationRequest,
) -> Result<ImageGenerationTestResult, String> {
    let started = Instant::now();
    let codex_config = request
        .use_codex_config
        .unwrap_or(false)
        .then(read_codex_provider_config)
        .flatten();
    let api_key = resolve_api_key(request.api_key, codex_config.as_ref())?;
    let model = validate_model(request.model.as_deref().unwrap_or(DEFAULT_MODEL))?;
    let image_endpoint =
        resolve_image_endpoint(request.base_url.as_deref(), codex_config.as_ref())?;
    let models_endpoint = image_endpoint_to_models_endpoint(&image_endpoint)?;

    log_info(&format!(
        "[文生图] 开始自检: model={}, endpoint={}",
        model, image_endpoint
    ));

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|e| format!("初始化网络客户端失败: {}", e))?;

    let models_response = client
        .get(&models_endpoint)
        .bearer_auth(&api_key)
        .send()
        .await
        .map_err(|e| format!("请求模型列表失败: {}", e))?;
    let models_status = models_response.status().as_u16();
    let models_body = models_response
        .text()
        .await
        .map_err(|e| format!("读取模型列表响应失败: {}", e))?;

    if !(200..300).contains(&models_status) {
        let message = extract_error_message(models_status, &models_body);
        log_error(&format!("[文生图] 自检失败: {}", message));
        return Ok(ImageGenerationTestResult {
            ok: false,
            endpoint: image_endpoint,
            models_endpoint,
            model,
            has_requested_model: false,
            image_models: Vec::new(),
            models_status: Some(models_status),
            generation_status: None,
            elapsed_ms: elapsed_millis(started),
            message: diagnose_image_generation_error(&message),
            detail: Some(message),
        });
    }

    let models = parse_model_ids(&models_body)?;
    let image_models = filter_image_model_ids(&models);
    let has_requested_model = models.iter().any(|id| id == &model);

    if !has_requested_model {
        let message = format!("模型列表中没有 {}", model);
        log_error(&format!("[文生图] 自检失败: {}", message));
        return Ok(ImageGenerationTestResult {
            ok: false,
            endpoint: image_endpoint,
            models_endpoint,
            model,
            has_requested_model,
            image_models,
            models_status: Some(models_status),
            generation_status: None,
            elapsed_ms: elapsed_millis(started),
            message,
            detail: Some("请切换到模型列表中可见的图片模型，或检查中转模型映射。".to_string()),
        });
    }

    let payload = json!({
        "model": model,
        "prompt": "Connection test image: one small blue circle on a plain white background. No extra text.",
        "size": DEFAULT_SIZE,
        "quality": "low",
        "output_format": DEFAULT_OUTPUT_FORMAT,
        "n": 1,
        "stream": true
    });

    let response = client
        .post(&image_endpoint)
        .bearer_auth(api_key)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("请求图片生成失败: {}", e))?;
    let generation_status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let generation_body = response
        .text()
        .await
        .map_err(|e| format!("读取图片生成响应失败: {}", e))?;

    if !(200..300).contains(&generation_status) {
        let detail = extract_error_message(generation_status, &generation_body);
        log_error(&format!("[文生图] 自检失败: {}", detail));
        return Ok(ImageGenerationTestResult {
            ok: false,
            endpoint: image_endpoint,
            models_endpoint,
            model,
            has_requested_model,
            image_models,
            models_status: Some(models_status),
            generation_status: Some(generation_status),
            elapsed_ms: elapsed_millis(started),
            message: diagnose_image_generation_error(&detail),
            detail: Some(detail),
        });
    }

    let decoded = decode_image_response(&client, &generation_body, &content_type).await?;
    if decoded.bytes.is_empty() {
        return Ok(ImageGenerationTestResult {
            ok: false,
            endpoint: image_endpoint,
            models_endpoint,
            model,
            has_requested_model,
            image_models,
            models_status: Some(models_status),
            generation_status: Some(generation_status),
            elapsed_ms: elapsed_millis(started),
            message: "接口返回成功，但没有图片数据".to_string(),
            detail: None,
        });
    }

    log_info(&format!(
        "[文生图] 自检通过: model={}, elapsed={}ms",
        model,
        elapsed_millis(started)
    ));

    Ok(ImageGenerationTestResult {
        ok: true,
        endpoint: image_endpoint,
        models_endpoint,
        model,
        has_requested_model,
        image_models,
        models_status: Some(models_status),
        generation_status: Some(generation_status),
        elapsed_ms: elapsed_millis(started),
        message: "连接正常，模型和图片生成权限可用".to_string(),
        detail: Some(format!(
            "测试图片响应 {} bytes，未写入输出目录。",
            decoded.bytes.len()
        )),
    })
}

async fn decode_image_response(
    client: &reqwest::Client,
    body: &str,
    content_type: &str,
) -> Result<DecodedImagePayload, String> {
    let is_event_stream = content_type
        .to_ascii_lowercase()
        .contains("text/event-stream")
        || body
            .lines()
            .any(|line| line.trim_start().starts_with("data:"));

    if is_event_stream {
        return decode_image_event_stream(client, body).await;
    }

    let parsed: OpenAIImageResponse =
        serde_json::from_str(body).map_err(|e| format!("解析 OpenAI 响应失败: {}", e))?;
    let first = parsed
        .data
        .into_iter()
        .next()
        .ok_or_else(|| "OpenAI 未返回图片数据".to_string())?;
    let bytes =
        decode_or_download_image(client, first.b64_json.as_deref(), first.url.as_deref()).await?;

    Ok(DecodedImagePayload {
        bytes,
        revised_prompt: first.revised_prompt,
        output_format: first.output_format,
    })
}

async fn decode_image_event_stream(
    client: &reqwest::Client,
    body: &str,
) -> Result<DecodedImagePayload, String> {
    let mut last_image: Option<(String, Option<String>, Option<String>, bool)> = None;
    let mut last_error: Option<String> = None;

    for line in body.lines() {
        let trimmed = line.trim();
        let Some(data) = trimmed.strip_prefix("data:") else {
            continue;
        };
        let data = data.trim();
        if data.is_empty() || data == "[DONE]" {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(data) else {
            continue;
        };

        if value.get("type").and_then(Value::as_str) == Some("error") {
            last_error = value
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| Some("图片流返回错误".to_string()));
            continue;
        }

        if let Some(image) = extract_stream_image_payload(&value) {
            last_image = Some(image);
        }
    }

    if let Some((payload, revised_prompt, output_format, is_url)) = last_image {
        let bytes = if is_url {
            decode_or_download_image(client, None, Some(&payload)).await?
        } else {
            decode_or_download_image(client, Some(&payload), None).await?
        };
        return Ok(DecodedImagePayload {
            bytes,
            revised_prompt,
            output_format,
        });
    }

    Err(last_error.unwrap_or_else(|| "图片流结束但没有返回最终图片".to_string()))
}

fn extract_stream_image_payload(
    value: &Value,
) -> Option<(String, Option<String>, Option<String>, bool)> {
    if let Some(b64_json) = value.get("b64_json").and_then(Value::as_str) {
        return Some((
            b64_json.to_string(),
            value
                .get("revised_prompt")
                .and_then(Value::as_str)
                .map(str::to_string),
            value
                .get("output_format")
                .and_then(Value::as_str)
                .map(str::to_string),
            false,
        ));
    }

    if let Some(url) = value.get("url").and_then(Value::as_str) {
        return Some((
            url.to_string(),
            value
                .get("revised_prompt")
                .and_then(Value::as_str)
                .map(str::to_string),
            value
                .get("output_format")
                .and_then(Value::as_str)
                .map(str::to_string),
            true,
        ));
    }

    if value.get("type").and_then(Value::as_str) == Some("response.output_item.done") {
        if let Some(item) = value.get("item") {
            return extract_response_image_generation_call(item);
        }
    }

    if value.get("type").and_then(Value::as_str) == Some("response.completed") {
        if let Some(items) = value
            .get("response")
            .and_then(|response| response.get("output"))
            .and_then(Value::as_array)
        {
            for item in items.iter().rev() {
                if let Some(image) = extract_response_image_generation_call(item) {
                    return Some(image);
                }
            }
        }
    }

    None
}

fn extract_response_image_generation_call(
    value: &Value,
) -> Option<(String, Option<String>, Option<String>, bool)> {
    if value.get("type").and_then(Value::as_str) != Some("image_generation_call") {
        return None;
    }

    value.get("result").and_then(Value::as_str).map(|result| {
        (
            result.to_string(),
            value
                .get("revised_prompt")
                .and_then(Value::as_str)
                .map(str::to_string),
            value
                .get("output_format")
                .and_then(Value::as_str)
                .map(str::to_string),
            false,
        )
    })
}

async fn decode_or_download_image(
    client: &reqwest::Client,
    b64_json: Option<&str>,
    url: Option<&str>,
) -> Result<Vec<u8>, String> {
    if let Some(b64_json) = b64_json {
        return BASE64
            .decode(normalize_base64_payload(b64_json))
            .map_err(|e| format!("解码图片失败: {}", e));
    }

    let Some(url) = url else {
        return Err("OpenAI 响应中没有图片内容".to_string());
    };

    if let Some(data) = url.trim().strip_prefix("data:") {
        let Some((_, b64)) = data.split_once(',') else {
            return Err("解析 data URL 图片失败".to_string());
        };
        return BASE64
            .decode(normalize_base64_payload(b64))
            .map_err(|e| format!("解码 data URL 图片失败: {}", e));
    }

    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("下载图片失败: {}", e))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("下载图片失败: HTTP {}", status.as_u16()));
    }

    response
        .bytes()
        .await
        .map(|bytes| bytes.to_vec())
        .map_err(|e| format!("读取图片下载结果失败: {}", e))
}

fn default_output_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("generated-images"))
        .map_err(|e| format!("读取默认输出目录失败: {}", e))
}

fn resolve_output_dir(app: &AppHandle, output_dir: Option<&str>) -> Result<PathBuf, String> {
    let dir = output_dir
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or(default_output_dir(app)?);

    if dir.exists() && !dir.is_dir() {
        return Err("输出路径不是文件夹".to_string());
    }

    Ok(dir)
}

fn resolve_api_key(
    api_key: Option<String>,
    codex_config: Option<&CodexProviderConfig>,
) -> Result<String, String> {
    api_key
        .and_then(|value| {
            let trimmed = value.trim().to_string();
            (!trimmed.is_empty()).then_some(trimmed)
        })
        .or_else(read_env_api_key)
        .or_else(|| codex_config.and_then(|config| read_codex_api_key(&config.codex_home)))
        .ok_or_else(|| {
            "缺少 API Key，请输入本次使用的 Key、设置 OPENAI_API_KEY，或使用可用的默认配置"
                .to_string()
        })
}

fn read_env_api_key() -> Option<String> {
    std::env::var("OPENAI_API_KEY")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn normalize_prompt(prompt: &str) -> Result<String, String> {
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err("请输入提示词".to_string());
    }

    if prompt.chars().count() > MAX_PROMPT_CHARS {
        return Err(format!("提示词过长，请控制在 {} 字以内", MAX_PROMPT_CHARS));
    }

    Ok(prompt.to_string())
}

fn validate_model(model: &str) -> Result<String, String> {
    let model = model.trim();
    if model.is_empty() {
        return Err("请输入图片模型".to_string());
    }

    if model.chars().count() > 128 {
        return Err("图片模型名称过长".to_string());
    }

    Ok(model.to_string())
}

fn validate_size(size: &str) -> Result<String, String> {
    match size {
        "1024x1024" | "1536x1024" | "1024x1536" => Ok(size.to_string()),
        _ => Err("不支持的图片尺寸".to_string()),
    }
}

fn validate_quality(quality: &str) -> Result<String, String> {
    match quality {
        "low" | "medium" | "high" => Ok(quality.to_string()),
        _ => Err("不支持的图片质量".to_string()),
    }
}

fn validate_background(background: &str) -> Result<String, String> {
    match background {
        "auto" | "transparent" => Ok(background.to_string()),
        _ => Err("不支持的背景模式".to_string()),
    }
}

fn validate_model_background(model: &str, background: &str) -> Result<(), String> {
    if model == "gpt-image-2" && background == "transparent" {
        return Err("gpt-image-2 暂不支持透明背景，请切换到 gpt-image-1.5".to_string());
    }

    Ok(())
}

fn resolve_image_endpoint(
    request_base_url: Option<&str>,
    codex_config: Option<&CodexProviderConfig>,
) -> Result<String, String> {
    let base_url = request_base_url
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| codex_config.and_then(|config| config.base_url.clone()))
        .unwrap_or_else(|| OPENAI_BASE_URL.to_string());

    normalize_image_endpoint(&base_url)
}

fn normalize_image_endpoint(base_url: &str) -> Result<String, String> {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("请输入服务地址".to_string());
    }

    if !trimmed.starts_with("https://") && !trimmed.starts_with("http://") {
        return Err("服务地址必须以 http:// 或 https:// 开头".to_string());
    }

    if trimmed.ends_with("/images/generations") {
        return Ok(trimmed.to_string());
    }

    if trimmed.ends_with("/v1") {
        return Ok(format!("{}/images/generations", trimmed));
    }

    Ok(format!("{}/v1/images/generations", trimmed))
}

fn image_endpoint_to_models_endpoint(image_endpoint: &str) -> Result<String, String> {
    let trimmed = image_endpoint.trim().trim_end_matches('/');
    let base = trimmed
        .strip_suffix("/images/generations")
        .ok_or_else(|| "无法从图片接口推导模型列表接口".to_string())?;
    Ok(format!("{}/models", base))
}

fn parse_model_ids(body: &str) -> Result<Vec<String>, String> {
    let parsed: OpenAIModelsResponse =
        serde_json::from_str(body).map_err(|e| format!("解析模型列表失败: {}", e))?;
    Ok(parsed.data.into_iter().map(|model| model.id).collect())
}

fn filter_image_model_ids(models: &[String]) -> Vec<String> {
    let mut image_models: Vec<String> = models
        .iter()
        .filter(|model| {
            let lower = model.to_ascii_lowercase();
            lower.contains("image") || lower.contains("dall-e")
        })
        .cloned()
        .collect();
    image_models.sort();
    image_models
}

fn elapsed_millis(started: Instant) -> u64 {
    started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
}

fn diagnose_image_generation_error(message: &str) -> String {
    let lower = message.to_ascii_lowercase();
    if lower.contains("image generation is not enabled") || lower.contains("permission_error") {
        return "当前 Key 或中转分组未开通图片生成权限".to_string();
    }
    if lower.contains("401") || lower.contains("unauthorized") || lower.contains("invalid api key")
    {
        return "API Key 无效或已过期".to_string();
    }
    if lower.contains("404") || lower.contains("model") && lower.contains("not found") {
        return "当前服务不支持所选图片模型".to_string();
    }
    if lower.contains("timeout") || lower.contains("timed out") {
        return "请求超时，服务可能排队较久或中转未正确转发流式响应".to_string();
    }
    if lower.contains("background") && lower.contains("transparent") {
        return "所选模型不支持透明背景，请切换模型或背景模式".to_string();
    }
    "图片生成自检失败，请查看详情".to_string()
}

fn read_codex_provider_config() -> Option<CodexProviderConfig> {
    codex_home_candidates()
        .into_iter()
        .filter(|path| path.exists())
        .find_map(|codex_home| {
            let config_path = codex_home.join("config.toml");
            let content = fs::read_to_string(config_path).ok()?;
            let provider = parse_codex_active_provider(&content)?;
            let base_url = parse_codex_provider_base_url(&content, &provider);

            Some(CodexProviderConfig {
                codex_home,
                provider,
                base_url,
            })
        })
}

fn codex_home_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(codex_home) = std::env::var("CODEX_HOME") {
        let path = PathBuf::from(codex_home);
        if !candidates.iter().any(|item| item == &path) {
            candidates.push(path);
        }
    }

    if let Ok(home) = std::env::var("HOME") {
        for name in [".codex", ".codex-erp"] {
            let path = Path::new(&home).join(name);
            if !candidates.iter().any(|item| item == &path) {
                candidates.push(path);
            }
        }
    }

    candidates
}

fn parse_codex_active_provider(content: &str) -> Option<String> {
    content.lines().find_map(|line| {
        parse_toml_string_assignment(line, "model_provider")
            .filter(|value| !value.trim().is_empty())
    })
}

fn parse_codex_provider_base_url(content: &str, provider: &str) -> Option<String> {
    let target_section = format!("model_providers.{}", provider);
    let mut in_target_section = false;

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            in_target_section = trimmed.trim_matches(['[', ']']) == target_section;
            continue;
        }

        if in_target_section {
            if let Some(base_url) = parse_toml_string_assignment(trimmed, "base_url") {
                return Some(base_url);
            }
        }
    }

    None
}

fn parse_toml_string_assignment(line: &str, key: &str) -> Option<String> {
    let trimmed = line.split('#').next()?.trim();
    let (left, right) = trimmed.split_once('=')?;
    if left.trim() != key {
        return None;
    }

    let right = right.trim();
    let value = right
        .strip_prefix('"')?
        .split('"')
        .next()?
        .trim()
        .to_string();
    (!value.is_empty()).then_some(value)
}

fn read_codex_api_key(codex_home: &Path) -> Option<String> {
    let content = fs::read_to_string(codex_home.join("auth.json")).ok()?;
    let parsed: Value = serde_json::from_str(&content).ok()?;
    parsed
        .get("OPENAI_API_KEY")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn validate_output_format(output_format: &str) -> Result<String, String> {
    match output_format {
        "png" | "jpeg" | "webp" => Ok(output_format.to_string()),
        _ => Err("不支持的图片格式".to_string()),
    }
}

fn normalize_output_format_hint(value: &str) -> Option<String> {
    let lower = value.trim().to_ascii_lowercase();
    match lower.as_str() {
        "png" | "image/png" => Some("png".to_string()),
        "jpg" | "jpeg" | "image/jpeg" => Some("jpeg".to_string()),
        "webp" | "image/webp" => Some("webp".to_string()),
        _ => None,
    }
}

fn normalize_base64_payload(value: &str) -> String {
    let trimmed = value.trim();
    let payload = if trimmed.to_ascii_lowercase().starts_with("data:") {
        trimmed
            .split_once(',')
            .map(|(_, data)| data)
            .unwrap_or(trimmed)
    } else {
        trimmed
    };
    let unpadded = payload.trim().trim_end_matches('=');
    format!("{}{}", unpadded, "=".repeat((4 - unpadded.len() % 4) % 4))
}

fn output_extension(output_format: &str) -> &'static str {
    match output_format {
        "jpeg" => "jpg",
        "webp" => "webp",
        _ => "png",
    }
}

fn mime_type(output_format: &str) -> &'static str {
    match output_format {
        "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        _ => "image/png",
    }
}

fn build_output_file_name(created_ms: u64, prompt: &str, extension: &str) -> String {
    let slug = sanitize_filename_part(prompt);
    format!("xwm_img_{}_{}.{}", created_ms, slug, extension)
}

fn sanitize_filename_part(value: &str) -> String {
    let mut slug = String::new();
    let mut last_was_separator = false;

    for character in value.chars() {
        if character.is_ascii_alphanumeric() {
            slug.push(character.to_ascii_lowercase());
            last_was_separator = false;
        } else if character.is_ascii() && !last_was_separator && !slug.is_empty() {
            slug.push('-');
            last_was_separator = true;
        }

        if slug.len() >= 36 {
            break;
        }
    }

    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() {
        "image".to_string()
    } else {
        slug
    }
}

fn extract_error_message(status: u16, body: &str) -> String {
    if let Ok(parsed) = serde_json::from_str::<OpenAIErrorResponse>(body) {
        if let Some(error) = parsed.error {
            let mut segments = Vec::new();
            if let Some(message) = error.message {
                segments.push(message);
            }
            if let Some(error_type) = error.r#type {
                segments.push(format!("type={}", error_type));
            }
            if let Some(code) = error.code {
                if !code.is_null() {
                    segments.push(format!("code={}", code));
                }
            }
            if !segments.is_empty() {
                return format!("OpenAI 返回 HTTP {}: {}", status, segments.join(" · "));
            }
        }
    }

    let trimmed = body.trim();
    if trimmed.is_empty() {
        format!("OpenAI 返回 HTTP {}", status)
    } else {
        let snippet: String = trimmed.chars().take(800).collect();
        format!("OpenAI 返回 HTTP {}: {}", status, snippet)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn sanitize_filename_part_uses_ascii_slug() {
        assert_eq!(
            sanitize_filename_part("Sunset Cat! 16:9"),
            "sunset-cat-16-9"
        );
        assert_eq!(sanitize_filename_part("傍晚的魔法书店"), "image");
        assert_eq!(sanitize_filename_part("  A___B---C  "), "a-b-c");
    }

    #[test]
    fn output_format_maps_to_extension_and_mime() {
        assert_eq!(output_extension("png"), "png");
        assert_eq!(output_extension("jpeg"), "jpg");
        assert_eq!(output_extension("webp"), "webp");
        assert_eq!(mime_type("jpeg"), "image/jpeg");
    }

    #[test]
    fn extracts_stream_completed_payload() {
        let value: Value = serde_json::from_str(
            r#"{"type":"image_generation.completed","b64_json":"aGVsbG8=","output_format":"png"}"#,
        )
        .unwrap();
        let (payload, _, output_format, is_url) =
            extract_stream_image_payload(&value).expect("image payload should parse");
        assert_eq!(payload, "aGVsbG8=");
        assert_eq!(output_format.as_deref(), Some("png"));
        assert!(!is_url);
    }

    #[test]
    fn extracts_response_completed_image_call() {
        let value: Value = serde_json::from_str(
            r#"{"type":"response.completed","response":{"output":[{"type":"image_generation_call","result":"aGVsbG8","revised_prompt":"draw","output_format":"webp"}]}}"#,
        )
        .unwrap();
        let (payload, revised_prompt, output_format, is_url) =
            extract_stream_image_payload(&value).expect("image payload should parse");
        assert_eq!(payload, "aGVsbG8");
        assert_eq!(revised_prompt.as_deref(), Some("draw"));
        assert_eq!(output_format.as_deref(), Some("webp"));
        assert!(!is_url);
    }

    #[test]
    fn normalizes_base64_padding_and_data_url() {
        assert_eq!(normalize_base64_payload("aGVsbG8"), "aGVsbG8=");
        assert_eq!(
            normalize_base64_payload("data:image/png;base64,aGVsbG8"),
            "aGVsbG8="
        );
    }

    #[test]
    fn gpt_image_2_rejects_transparent_background() {
        assert!(validate_model_background("gpt-image-2", "transparent").is_err());
        assert!(validate_model_background("gpt-image-1.5", "transparent").is_ok());
    }

    #[test]
    fn normalizes_base_url_to_image_endpoint() {
        assert_eq!(
            normalize_image_endpoint("https://code.3ms.fun").unwrap(),
            "https://code.3ms.fun/v1/images/generations"
        );
        assert_eq!(
            normalize_image_endpoint("https://code.3ms.fun/v1").unwrap(),
            "https://code.3ms.fun/v1/images/generations"
        );
        assert_eq!(
            normalize_image_endpoint("https://code.3ms.fun/v1/images/generations").unwrap(),
            "https://code.3ms.fun/v1/images/generations"
        );
        assert!(normalize_image_endpoint("code.3ms.fun").is_err());
    }

    #[test]
    fn derives_models_endpoint_from_image_endpoint() {
        assert_eq!(
            image_endpoint_to_models_endpoint("https://code.3ms.fun/v1/images/generations")
                .as_deref(),
            Ok("https://code.3ms.fun/v1/models")
        );
    }

    #[test]
    fn parses_and_filters_image_models() {
        let body = r#"{"data":[{"id":"gpt-5.2"},{"id":"gpt-image-2"},{"id":"dall-e-3"},{"id":"gpt-image-1.5"}]}"#;
        let models = parse_model_ids(body).unwrap();
        assert_eq!(
            filter_image_model_ids(&models),
            vec![
                "dall-e-3".to_string(),
                "gpt-image-1.5".to_string(),
                "gpt-image-2".to_string()
            ]
        );
    }

    #[test]
    fn diagnoses_image_permission_error() {
        assert_eq!(
            diagnose_image_generation_error(
                "OpenAI 返回 HTTP 403: Image generation is not enabled for this group"
            ),
            "当前 Key 或中转分组未开通图片生成权限"
        );
    }

    #[test]
    fn parses_codex_provider_base_url() {
        let content = r#"
model_provider = "OpenAI"

[model_providers.OpenAI]
name = "OpenAI"
base_url = "https://code.3ms.fun"
wire_api = "responses"
"#;

        let provider = parse_codex_active_provider(content).expect("provider should parse");
        assert_eq!(provider, "OpenAI");
        assert_eq!(
            parse_codex_provider_base_url(content, &provider).as_deref(),
            Some("https://code.3ms.fun")
        );
    }

    #[test]
    fn explicit_api_key_overrides_codex_default_key() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let codex_home = std::env::temp_dir().join(format!("xwm-codex-test-{}", suffix));
        fs::create_dir_all(&codex_home).unwrap();
        fs::write(
            codex_home.join("auth.json"),
            r#"{"OPENAI_API_KEY":"sk-default-from-codex"}"#,
        )
        .unwrap();

        let config = CodexProviderConfig {
            codex_home: codex_home.clone(),
            provider: "OpenAI".to_string(),
            base_url: Some("https://relay.example.com".to_string()),
        };

        assert_eq!(
            resolve_api_key(Some(" sk-manual-from-app ".to_string()), Some(&config)).as_deref(),
            Ok("sk-manual-from-app")
        );

        let _ = fs::remove_dir_all(codex_home);
    }

    #[test]
    fn extracts_openai_error_message() {
        let body = r#"{"error":{"message":"bad prompt","type":"invalid_request_error","code":"bad_request"}}"#;
        let message = extract_error_message(400, body);
        assert!(message.contains("HTTP 400"));
        assert!(message.contains("bad prompt"));
        assert!(message.contains("invalid_request_error"));
    }
}
