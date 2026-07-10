use std::collections::VecDeque;
#[cfg(test)]
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Manager};

mod image_io;
mod mask;
mod repair;
mod runner;
mod selection;
mod task;
mod temp;
mod types;

use super::ffmpeg_utils::get_ffmpeg_path;
use super::file_ops::{path_entry_exists, validate_input_file, TemporaryOutput};
use super::logger::{log_error, log_info};
use super::process::ProcessSlot;
use image_io::{
    decode_image_rgba, generate_thumbnail, probe_image_dimensions, probe_image_dimensions_tracked,
    run_ffmpeg_repair_fallback,
};
#[cfg(test)]
use mask::apply_brush_strokes;
use mask::build_repair_mask;
use repair::{luma, read_rgba_pixel, run_texture_repair};
#[cfg(test)]
use repair::{
    repair_mask_with_gradient_fill, repair_mask_with_texture_fill, should_use_gradient_repair,
    soften_repair_edges, RGBA_CHANNELS,
};
use runner::{ffmpeg_process_slot, kill_current_ffmpeg, run_command_output};
use selection::{normalize_selection_bounds, SelectionRect};
#[cfg(test)]
use task::lock_cancelled_tasks;
use task::{
    cleanup_batch_task, emit_batch_progress, ensure_not_cancelled, mark_batch_task_cancelled,
    register_batch_task,
};
use temp::remove_file_quietly;
use types::{BrushStroke, CropResult, ImageInfo, WatermarkBatchResult};

#[derive(Clone)]
struct MaskComponent {
    pixels: Vec<(u32, u32)>,
    min_x: u32,
    max_x: u32,
    min_y: u32,
    max_y: u32,
}

const AUTO_MASK_LOCAL_RADIUS: u32 = 4;
const AUTO_MASK_STRONG_LUMA_DELTA: i32 = 18;
const AUTO_MASK_WEAK_LUMA_DELTA: i32 = 10;
const AUTO_MASK_MIN_PIXELS: usize = 6;
const AUTO_MASK_COMPONENT_GAP_X: u32 = 28;
const AUTO_MASK_COMPONENT_GAP_Y: u32 = 18;
const AUTO_MASK_SMALL_SELECTION_MAX_PERCENT: usize = 3;

fn create_unique_output_path(input: &Path, suffix: &str) -> PathBuf {
    let stem = input
        .file_stem()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "output".to_string());
    let extension = input
        .extension()
        .map(|value| format!(".{}", value.to_string_lossy()))
        .unwrap_or_default();
    let parent = input.parent().unwrap_or(Path::new("."));

    let mut candidate = parent.join(format!("{}{}{}", stem, suffix, extension));
    let mut index = 2_u32;

    while candidate == input || path_entry_exists(&candidate) {
        candidate = parent.join(format!("{}{}-{}{}", stem, suffix, index, extension));
        index += 1;
    }

    candidate
}

fn uses_rect_base(mode: Option<&str>) -> bool {
    !matches!(mode, Some("blank"))
}

fn clamp_fill_opacity(opacity: Option<u8>) -> u8 {
    opacity.unwrap_or(100).clamp(0, 100)
}

fn clamp_blur_strength(strength: Option<u32>) -> u32 {
    strength.unwrap_or(15).clamp(1, 30)
}

#[allow(clippy::too_many_arguments)]
fn mean_color_in_window(
    pixels: &[u8],
    image_width: u32,
    x: u32,
    y: u32,
    min_x: u32,
    max_x: u32,
    min_y: u32,
    max_y: u32,
) -> [u8; 4] {
    let mut sums = [0_u32; 4];
    let mut count = 0_u32;

    for sample_y in min_y..=max_y {
        for sample_x in min_x..=max_x {
            if sample_x == x && sample_y == y {
                continue;
            }
            let color = read_rgba_pixel(pixels, image_width, sample_x, sample_y);
            for channel in 0..4 {
                sums[channel] += color[channel] as u32;
            }
            count += 1;
        }
    }

    if count == 0 {
        read_rgba_pixel(pixels, image_width, x, y)
    } else {
        [
            (sums[0] / count) as u8,
            (sums[1] / count) as u8,
            (sums[2] / count) as u8,
            (sums[3] / count) as u8,
        ]
    }
}

fn dilate_mask_within_selection(
    mask: &[u8],
    image_width: u32,
    image_height: u32,
    selection: SelectionRect,
    radius: u32,
) -> Vec<u8> {
    let mut output = vec![0_u8; mask.len()];

    for y in 0..image_height {
        for x in 0..image_width {
            let index = y as usize * image_width as usize + x as usize;
            if mask[index] == 0 {
                continue;
            }

            let min_x = x.saturating_sub(radius).max(selection.x);
            let max_x = (x + radius).min(selection.x + selection.width - 1);
            let min_y = y.saturating_sub(radius).max(selection.y);
            let max_y = (y + radius).min(selection.y + selection.height - 1);

            for neighbor_y in min_y..=max_y {
                for neighbor_x in min_x..=max_x {
                    let neighbor_index =
                        neighbor_y as usize * image_width as usize + neighbor_x as usize;
                    output[neighbor_index] = 255;
                }
            }
        }
    }

    output
}

fn extract_mask_components(
    mask: &[u8],
    image_width: u32,
    selection: SelectionRect,
) -> Vec<MaskComponent> {
    let mut visited = vec![false; mask.len()];
    let mut components = Vec::new();

    for y in selection.y..selection.y + selection.height {
        for x in selection.x..selection.x + selection.width {
            let index = y as usize * image_width as usize + x as usize;
            if mask[index] == 0 || visited[index] {
                continue;
            }

            let mut queue = VecDeque::from([(x, y)]);
            let mut pixels = Vec::new();
            let mut min_x = x;
            let mut max_x = x;
            let mut min_y = y;
            let mut max_y = y;
            visited[index] = true;

            while let Some((current_x, current_y)) = queue.pop_front() {
                pixels.push((current_x, current_y));
                min_x = min_x.min(current_x);
                max_x = max_x.max(current_x);
                min_y = min_y.min(current_y);
                max_y = max_y.max(current_y);

                let start_x = current_x.saturating_sub(1).max(selection.x);
                let end_x = (current_x + 1).min(selection.x + selection.width - 1);
                let start_y = current_y.saturating_sub(1).max(selection.y);
                let end_y = (current_y + 1).min(selection.y + selection.height - 1);

                for neighbor_y in start_y..=end_y {
                    for neighbor_x in start_x..=end_x {
                        let neighbor_index =
                            neighbor_y as usize * image_width as usize + neighbor_x as usize;
                        if mask[neighbor_index] == 0 || visited[neighbor_index] {
                            continue;
                        }
                        visited[neighbor_index] = true;
                        queue.push_back((neighbor_x, neighbor_y));
                    }
                }
            }

            components.push(MaskComponent {
                pixels,
                min_x,
                max_x,
                min_y,
                max_y,
            });
        }
    }

    components.sort_by(|left, right| right.pixels.len().cmp(&left.pixels.len()));
    components
}

fn component_gap(left_min: u32, left_max: u32, right_min: u32, right_max: u32) -> u32 {
    if left_max < right_min {
        right_min.saturating_sub(left_max + 1)
    } else if right_max < left_min {
        left_min.saturating_sub(right_max + 1)
    } else {
        0
    }
}

fn refine_rect_mask_by_local_contrast(
    pixels: &[u8],
    image_width: u32,
    image_height: u32,
    selection: SelectionRect,
) -> Option<Vec<u8>> {
    let selection_area = selection.width as usize * selection.height as usize;
    if selection_area < AUTO_MASK_MIN_PIXELS {
        return None;
    }

    let mut strong_mask = vec![0_u8; image_width as usize * image_height as usize];
    let mut weak_mask = vec![0_u8; image_width as usize * image_height as usize];

    for y in selection.y..selection.y + selection.height {
        for x in selection.x..selection.x + selection.width {
            let min_x = x.saturating_sub(AUTO_MASK_LOCAL_RADIUS).max(selection.x);
            let max_x = (x + AUTO_MASK_LOCAL_RADIUS).min(selection.x + selection.width - 1);
            let min_y = y.saturating_sub(AUTO_MASK_LOCAL_RADIUS).max(selection.y);
            let max_y = (y + AUTO_MASK_LOCAL_RADIUS).min(selection.y + selection.height - 1);

            let mean = mean_color_in_window(pixels, image_width, x, y, min_x, max_x, min_y, max_y);
            let current = read_rgba_pixel(pixels, image_width, x, y);
            let delta = (luma(current) - luma(mean)).unsigned_abs() as i32;
            let index = y as usize * image_width as usize + x as usize;

            if delta >= AUTO_MASK_STRONG_LUMA_DELTA {
                strong_mask[index] = 255;
                weak_mask[index] = 255;
            } else if delta >= AUTO_MASK_WEAK_LUMA_DELTA {
                weak_mask[index] = 255;
            }
        }
    }

    let grouped_strong =
        dilate_mask_within_selection(&strong_mask, image_width, image_height, selection, 1);
    let components = extract_mask_components(&grouped_strong, image_width, selection);
    let mut selected_mask = vec![0_u8; image_width as usize * image_height as usize];
    let image_area = image_width as usize * image_height as usize;
    let is_small_selection =
        selection_area * 100 <= image_area * AUTO_MASK_SMALL_SELECTION_MAX_PERCENT;

    if is_small_selection {
        let mut has_component = false;
        for component in &components {
            if component.pixels.len() < AUTO_MASK_MIN_PIXELS {
                continue;
            }
            has_component = true;
            for (x, y) in &component.pixels {
                selected_mask[*y as usize * image_width as usize + *x as usize] = 255;
            }
        }

        if !has_component {
            return None;
        }
    } else {
        let anchor = components.first()?;
        if anchor.pixels.len() < AUTO_MASK_MIN_PIXELS {
            return None;
        }

        let mut selected_components = vec![anchor.clone()];

        for (x, y) in &anchor.pixels {
            selected_mask[*y as usize * image_width as usize + *x as usize] = 255;
        }

        let mut changed = true;
        while changed {
            changed = false;

            for component in &components[1..] {
                if component.pixels.len() < AUTO_MASK_MIN_PIXELS {
                    continue;
                }

                let already_selected = component.pixels.iter().all(|(x, y)| {
                    selected_mask[*y as usize * image_width as usize + *x as usize] == 255
                });
                if already_selected {
                    continue;
                }

                let is_adjacent = selected_components.iter().any(|selected| {
                    let gap_x = component_gap(
                        component.min_x,
                        component.max_x,
                        selected.min_x,
                        selected.max_x,
                    );
                    let gap_y = component_gap(
                        component.min_y,
                        component.max_y,
                        selected.min_y,
                        selected.max_y,
                    );
                    let gap_y_to_anchor =
                        component_gap(component.min_y, component.max_y, anchor.min_y, anchor.max_y);

                    gap_x <= AUTO_MASK_COMPONENT_GAP_X
                        && gap_y <= AUTO_MASK_COMPONENT_GAP_Y
                        && gap_y_to_anchor <= AUTO_MASK_COMPONENT_GAP_Y
                });

                if is_adjacent {
                    for (x, y) in &component.pixels {
                        selected_mask[*y as usize * image_width as usize + *x as usize] = 255;
                    }
                    selected_components.push(component.clone());
                    changed = true;
                }
            }
        }
    }

    let mut refined = selected_mask.clone();
    let mut queue = VecDeque::new();

    for y in selection.y..selection.y + selection.height {
        for x in selection.x..selection.x + selection.width {
            let index = y as usize * image_width as usize + x as usize;
            if selected_mask[index] == 255 {
                queue.push_back((x, y));
            }
        }
    }

    while let Some((x, y)) = queue.pop_front() {
        let min_x = x.saturating_sub(1).max(selection.x);
        let max_x = (x + 1).min(selection.x + selection.width - 1);
        let min_y = y.saturating_sub(1).max(selection.y);
        let max_y = (y + 1).min(selection.y + selection.height - 1);

        for neighbor_y in min_y..=max_y {
            for neighbor_x in min_x..=max_x {
                let neighbor_index =
                    neighbor_y as usize * image_width as usize + neighbor_x as usize;
                if weak_mask[neighbor_index] == 0 || refined[neighbor_index] == 255 {
                    continue;
                }

                refined[neighbor_index] = 255;
                queue.push_back((neighbor_x, neighbor_y));
            }
        }
    }

    let dilation_radius = if is_small_selection { 2 } else { 1 };
    let refined = dilate_mask_within_selection(
        &refined,
        image_width,
        image_height,
        selection,
        dilation_radius,
    );
    let refined_count = refined.iter().filter(|value| **value > 0).count();
    if refined_count < AUTO_MASK_MIN_PIXELS || refined_count * 3 >= selection_area * 2 {
        return None;
    }

    Some(refined)
}

#[tauri::command]
pub async fn get_image_info(app: AppHandle, path: String) -> Result<ImageInfo, String> {
    tokio::task::spawn_blocking(move || {
        let input = Path::new(&path);
        validate_input_file(input)?;
        app.asset_protocol_scope()
            .allow_file(input)
            .map_err(|error| format!("无法授权图片预览: {}", error))?;
        log_info("[去水印] 获取图片信息");

        let (width, height) = probe_image_dimensions(&app, &path).inspect_err(|_| {
            log_error("[去水印] 获取图片尺寸失败");
        })?;

        log_info(&format!("[去水印] 图片尺寸: {}x{}", width, height));

        let thumbnail = generate_thumbnail(&path, &app).unwrap_or_default();

        Ok(ImageInfo {
            width,
            height,
            path,
            thumbnail,
        })
    })
    .await
    .map_err(|error| format!("读取图片信息任务失败: {}", error))?
}

#[allow(clippy::too_many_arguments)]
fn remove_watermark_impl(
    app: &AppHandle,
    input_path: &str,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    color: &str,
    fill_opacity: Option<u8>,
    blur_strength: Option<u32>,
    mode: &str,
    repair_base_mode: Option<&str>,
    brush_strokes: &[BrushStroke],
    brush_size: u32,
    process_slot: Option<&ProcessSlot>,
    cancelled: Option<&AtomicBool>,
) -> Result<CropResult, String> {
    ensure_not_cancelled(cancelled)?;

    let input = Path::new(input_path);
    validate_input_file(input)?;

    let (image_width, image_height) =
        probe_image_dimensions_tracked(app, input_path, process_slot, cancelled)?;
    ensure_not_cancelled(cancelled)?;

    let selection = normalize_selection_bounds(image_width, image_height, x, y, width, height)?;
    let ffmpeg = get_ffmpeg_path(app);
    let output_path = create_unique_output_path(input, "_no_watermark");
    let temporary_output = TemporaryOutput::new(&output_path)?;
    let working_output_path = temporary_output.path().to_path_buf();

    log_info(&format!(
        "[去水印] 开始处理: mode={}, rect=({}, {}, {}, {})",
        mode, selection.x, selection.y, selection.width, selection.height
    ));

    let fill_opacity = clamp_fill_opacity(fill_opacity);
    let blur_strength = clamp_blur_strength(blur_strength);
    let fill_alpha = fill_opacity as f32 / 100.0;

    let ffmpeg_color = if let Some(color) = color.strip_prefix('#') {
        format!("0x{}@{:.2}", color, fill_alpha)
    } else {
        format!("{}@{:.2}", color, fill_alpha)
    };

    match mode {
        "repair" => {
            let use_rect_base = uses_rect_base(repair_base_mode);
            let mut mask = build_repair_mask(
                image_width,
                image_height,
                selection,
                use_rect_base,
                brush_strokes,
                brush_size.max(1),
            );
            if !mask.iter().any(|pixel| *pixel > 0) {
                return Err("请先框选或涂抹要修复的区域".to_string());
            }

            ensure_not_cancelled(cancelled)?;
            match decode_image_rgba(
                app,
                input_path,
                image_width,
                image_height,
                process_slot,
                cancelled,
            ) {
                Ok(mut pixels) => {
                    ensure_not_cancelled(cancelled)?;
                    if use_rect_base && brush_strokes.is_empty() {
                        if let Some(refined_mask) = refine_rect_mask_by_local_contrast(
                            &pixels,
                            image_width,
                            image_height,
                            selection,
                        ) {
                            let refined_count =
                                refined_mask.iter().filter(|value| **value > 0).count();
                            log_info(&format!(
                                "[去水印] 自动收窄矩形蒙版: {} -> {} 像素",
                                mask.iter().filter(|value| **value > 0).count(),
                                refined_count
                            ));
                            mask = refined_mask;
                        }
                    }

                    ensure_not_cancelled(cancelled)?;
                    if let Err(_error) = run_texture_repair(
                        app,
                        &mut pixels,
                        &working_output_path,
                        &mask,
                        image_width,
                        image_height,
                        process_slot,
                        cancelled,
                    ) {
                        ensure_not_cancelled(cancelled)?;
                        log_error("[去水印] 纹理修补失败，回退到 FFmpeg removelogo");
                        remove_file_quietly(&working_output_path);
                        run_ffmpeg_repair_fallback(
                            &ffmpeg,
                            input_path,
                            &working_output_path,
                            &mask,
                            image_width,
                            image_height,
                            process_slot,
                            cancelled,
                        )?;
                    }
                }
                Err(_error) => {
                    ensure_not_cancelled(cancelled)?;
                    log_error("[去水印] 读取像素失败，回退到 FFmpeg removelogo");
                    run_ffmpeg_repair_fallback(
                        &ffmpeg,
                        input_path,
                        &working_output_path,
                        &mask,
                        image_width,
                        image_height,
                        process_slot,
                        cancelled,
                    )?;
                }
            }
        }
        "blur" => {
            let filter = format!(
                "[0:v]crop={}:{}:{}:{}[crop];[crop]boxblur={}:3[blur];[0:v][blur]overlay={}:{}",
                selection.width,
                selection.height,
                selection.x,
                selection.y,
                blur_strength,
                selection.x,
                selection.y
            );
            let output_path_string = working_output_path.to_string_lossy().to_string();

            let mut command = Command::new(&ffmpeg);
            command.args([
                "-n",
                "-i",
                input_path,
                "-filter_complex",
                &filter,
                "-q:v",
                "1",
                &output_path_string,
            ]);
            let output = run_command_output(&mut command, process_slot, cancelled, "处理失败")?;

            if !output.status.success() {
                remove_file_quietly(&working_output_path);
                let stderr = String::from_utf8_lossy(&output.stderr);
                log_error("[去水印] FFmpeg 处理失败");
                return Err(format!("处理失败: {}", stderr));
            }
        }
        _ => {
            let filter = format!(
                "drawbox=x={}:y={}:w={}:h={}:color={}:t=fill",
                selection.x, selection.y, selection.width, selection.height, ffmpeg_color
            );
            let output_path_string = working_output_path.to_string_lossy().to_string();

            let mut command = Command::new(&ffmpeg);
            command.args([
                "-n",
                "-i",
                input_path,
                "-vf",
                &filter,
                "-q:v",
                "1",
                &output_path_string,
            ]);
            let output = run_command_output(&mut command, process_slot, cancelled, "处理失败")?;

            if !output.status.success() {
                remove_file_quietly(&working_output_path);
                let stderr = String::from_utf8_lossy(&output.stderr);
                log_error("[去水印] FFmpeg 处理失败");
                return Err(format!("处理失败: {}", stderr));
            }
        }
    }

    ensure_not_cancelled(cancelled)?;
    temporary_output.commit(&output_path)?;

    Ok(CropResult {
        success: true,
        output_path: output_path.to_string_lossy().to_string(),
        message: format!("已保存到: {}", output_path.display()),
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn remove_watermark(
    app: AppHandle,
    input_path: String,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    color: String,
    fill_opacity: Option<u8>,
    blur_strength: Option<u32>,
    mode: String,
    repair_base_mode: Option<String>,
    brush_strokes: Vec<BrushStroke>,
    brush_size: u32,
) -> Result<CropResult, String> {
    tokio::task::spawn_blocking(move || {
        remove_watermark_impl(
            &app,
            &input_path,
            x,
            y,
            width,
            height,
            &color,
            fill_opacity,
            blur_strength,
            &mode,
            repair_base_mode.as_deref(),
            &brush_strokes,
            brush_size,
            None,
            None,
        )
    })
    .await
    .map_err(|error| format!("水印任务执行失败: {}", error))?
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn batch_remove_watermark(
    app: AppHandle,
    task_id: String,
    input_paths: Vec<String>,
    expected_width: Option<u32>,
    expected_height: Option<u32>,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    color: String,
    fill_opacity: Option<u8>,
    blur_strength: Option<u32>,
    mode: String,
    repair_base_mode: Option<String>,
    brush_strokes: Vec<BrushStroke>,
    brush_size: u32,
) -> Result<WatermarkBatchResult, String> {
    if input_paths.is_empty() {
        return Err("请先选择要处理的图片".into());
    }
    let cancelled = register_batch_task(&task_id)?;
    let task_id_for_cleanup = task_id.clone();
    let task_result = tokio::task::spawn_blocking(move || {
        let task_result: Result<WatermarkBatchResult, String> = {
            let total = input_paths.len();
            let mut results = Vec::new();
            let mut succeeded = 0usize;
            let mut failed = 0usize;
            let mut was_cancelled = false;

            emit_batch_progress(&app, &task_id, "准备批量处理", 0, total, "".into(), 0, 0);

            for (index, path) in input_paths.iter().enumerate() {
                if cancelled.load(Ordering::SeqCst) {
                    was_cancelled = true;
                    break;
                }

                let current_file = Path::new(path)
                    .file_name()
                    .map(|value| value.to_string_lossy().to_string())
                    .unwrap_or_else(|| path.clone());
                emit_batch_progress(
                    &app,
                    &task_id,
                    "处理中",
                    index,
                    total,
                    current_file.clone(),
                    succeeded,
                    failed,
                );

                if let (Some(expected_width), Some(expected_height)) =
                    (expected_width, expected_height)
                {
                    match probe_image_dimensions_tracked(
                        &app,
                        path,
                        Some(ffmpeg_process_slot()),
                        Some(&cancelled),
                    ) {
                        Ok((actual_width, actual_height)) => {
                            if actual_width != expected_width || actual_height != expected_height {
                                failed += 1;
                                results.push(CropResult {
                                    success: false,
                                    output_path: String::new(),
                                    message: format!(
                                        "{}: 尺寸不匹配，当前为 {}x{}，期望 {}x{}",
                                        path,
                                        actual_width,
                                        actual_height,
                                        expected_width,
                                        expected_height
                                    ),
                                });
                                emit_batch_progress(
                                    &app,
                                    &task_id,
                                    "处理中",
                                    index + 1,
                                    total,
                                    current_file,
                                    succeeded,
                                    failed,
                                );
                                continue;
                            }
                        }
                        Err(error) => {
                            failed += 1;
                            results.push(CropResult {
                                success: false,
                                output_path: String::new(),
                                message: format!("{}: {}", path, error),
                            });
                            emit_batch_progress(
                                &app,
                                &task_id,
                                "处理中",
                                index + 1,
                                total,
                                current_file,
                                succeeded,
                                failed,
                            );
                            continue;
                        }
                    }
                }

                if cancelled.load(Ordering::SeqCst) {
                    was_cancelled = true;
                    break;
                }
                match remove_watermark_impl(
                    &app,
                    path,
                    x,
                    y,
                    width,
                    height,
                    &color,
                    fill_opacity,
                    blur_strength,
                    &mode,
                    repair_base_mode.as_deref(),
                    &brush_strokes,
                    brush_size.max(1),
                    Some(ffmpeg_process_slot()),
                    Some(&cancelled),
                ) {
                    Ok(result) => {
                        succeeded += 1;
                        results.push(result);
                    }
                    Err(error) if error.contains("取消") || cancelled.load(Ordering::SeqCst) => {
                        was_cancelled = true;
                        break;
                    }
                    Err(error) => {
                        failed += 1;
                        results.push(CropResult {
                            success: false,
                            output_path: String::new(),
                            message: format!("{}: {}", path, error),
                        });
                    }
                }

                emit_batch_progress(
                    &app,
                    &task_id,
                    "处理中",
                    index + 1,
                    total,
                    current_file,
                    succeeded,
                    failed,
                );
            }

            let completed = results.len();
            emit_batch_progress(
                &app,
                &task_id,
                if was_cancelled { "已取消" } else { "完成" },
                completed,
                total,
                "".into(),
                succeeded,
                failed,
            );

            Ok(WatermarkBatchResult {
                cancelled: was_cancelled,
                items: results,
            })
        };

        task_result
    })
    .await;

    cleanup_batch_task(&task_id_for_cleanup);
    task_result.map_err(|error| format!("批量水印任务执行失败: {}", error))?
}

#[tauri::command]
pub fn cancel_watermark_task(task_id: String) {
    if !mark_batch_task_cancelled(&task_id) {
        return;
    }
    log_info(&format!("[去水印] 收到取消请求: {}", task_id));
    kill_current_ffmpeg();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static NEXT_TEST_ID: AtomicUsize = AtomicUsize::new(0);

    struct TestDir {
        path: PathBuf,
    }

    impl TestDir {
        fn new() -> Self {
            let unique = format!(
                "watermark-test-{}-{}-{}",
                std::process::id(),
                NEXT_TEST_ID.fetch_add(1, Ordering::Relaxed),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            );
            let path = std::env::temp_dir().join(unique);
            fs::create_dir_all(&path).expect("create temp dir");
            Self { path }
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn unique_task_id(prefix: &str) -> String {
        format!(
            "{}-{}-{}",
            prefix,
            std::process::id(),
            NEXT_TEST_ID.fetch_add(1, Ordering::Relaxed)
        )
    }

    #[test]
    fn batch_task_cancel_flag_is_registered_and_cleaned_up() {
        let task_id = unique_task_id("watermark-cancel-test");
        let cancelled = register_batch_task(&task_id).expect("register batch task");

        assert!(!cancelled.load(Ordering::SeqCst));
        assert!(mark_batch_task_cancelled(&task_id));
        assert!(cancelled.load(Ordering::SeqCst));

        cleanup_batch_task(&task_id);
        assert!(!lock_cancelled_tasks().contains_key(&task_id));
    }

    #[test]
    fn ensure_not_cancelled_returns_cancel_error() {
        let cancelled = AtomicBool::new(true);
        let error = ensure_not_cancelled(Some(&cancelled)).expect_err("cancelled flag should fail");

        assert!(error.contains("取消"));
    }

    #[test]
    fn normalize_selection_bounds_clamps_to_image_size() {
        let rect =
            normalize_selection_bounds(100, 80, 90, 70, 30, 40).expect("selection should be valid");
        assert_eq!(
            rect,
            SelectionRect {
                x: 90,
                y: 70,
                width: 10,
                height: 10,
            }
        );
    }

    #[test]
    fn build_repair_mask_combines_rect_and_erase_strokes() {
        let selection = SelectionRect {
            x: 2,
            y: 2,
            width: 4,
            height: 4,
        };
        let strokes = vec![
            BrushStroke {
                x: 1.5,
                y: 1.5,
                size: 3,
                erase: false,
                start: true,
            },
            BrushStroke {
                x: 3.5,
                y: 3.5,
                size: 2,
                erase: true,
                start: true,
            },
        ];

        let mask = build_repair_mask(8, 8, selection, true, &strokes, 3);
        let pixel = |x: usize, y: usize| mask[y * 8 + x];

        assert_eq!(pixel(1, 1), 255, "brush should paint outside the base rect");
        assert_eq!(pixel(3, 3), 0, "erase stroke should carve a hole");
        assert_eq!(pixel(2, 2), 255, "base rect should remain painted");
    }

    #[test]
    fn build_repair_mask_can_start_from_blank_mask() {
        let selection = SelectionRect {
            x: 2,
            y: 2,
            width: 3,
            height: 3,
        };
        let strokes = vec![BrushStroke {
            x: 6.0,
            y: 6.0,
            size: 3,
            erase: false,
            start: true,
        }];

        let mask = build_repair_mask(10, 10, selection, false, &strokes, 3);
        let pixel = |x: usize, y: usize| mask[y * 10 + x];

        assert_eq!(pixel(3, 3), 0, "blank mode should not auto-fill the rect");
        assert_eq!(pixel(6, 6), 255, "brush strokes should define the mask");
    }

    #[test]
    fn apply_brush_strokes_connects_points_within_same_gesture() {
        let mut mask = vec![0_u8; 20 * 20];
        let strokes = vec![
            BrushStroke {
                x: 2.0,
                y: 10.0,
                size: 4,
                erase: false,
                start: true,
            },
            BrushStroke {
                x: 14.0,
                y: 10.0,
                size: 4,
                erase: false,
                start: false,
            },
        ];

        apply_brush_strokes(&mut mask, 20, 20, &strokes, 4);

        assert_eq!(
            mask[10 * 20 + 8],
            255,
            "interpolation should fill the gap between points"
        );
    }

    #[test]
    fn texture_repair_blends_horizontal_gradient_without_blur_filter() {
        let image_width = 6;
        let image_height = 1;
        let mut pixels = Vec::new();

        for value in [0_u8, 20, 40, 60, 80, 100] {
            pixels.extend_from_slice(&[value, value, value, 255]);
        }

        let mask = vec![0_u8, 0, 255, 255, 0, 0];
        repair_mask_with_texture_fill(&mut pixels, &mask, image_width, image_height)
            .expect("texture repair should succeed");

        assert_eq!(
            read_rgba_pixel(&pixels, image_width, 2, 0),
            [40, 40, 40, 255]
        );
        assert_eq!(
            read_rgba_pixel(&pixels, image_width, 3, 0),
            [60, 60, 60, 255]
        );
    }

    #[test]
    fn texture_repair_fails_when_mask_covers_everything() {
        let mut pixels = vec![128_u8; 4 * 4 * RGBA_CHANNELS];
        let mask = vec![255_u8; 16];

        let error = repair_mask_with_texture_fill(&mut pixels, &mask, 4, 4)
            .expect_err("full-image mask should fail");

        assert!(
            error.contains("修复区域过大") || error.contains("缺少可参考"),
            "unexpected error: {}",
            error
        );
    }

    #[test]
    fn dilate_mask_within_selection_keeps_growth_inside_bounds() {
        let image_width = 20;
        let image_height = 14;
        let mut mask = vec![0_u8; (image_width * image_height) as usize];
        let selection = SelectionRect {
            x: 6,
            y: 3,
            width: 10,
            height: 7,
        };

        mask[3 * image_width as usize + 6] = 255;

        let dilated = dilate_mask_within_selection(&mask, image_width, image_height, selection, 2);

        assert_eq!(dilated[0], 0, "growth must not leak above selection");
        assert_eq!(
            dilated[2 * image_width as usize + 6],
            0,
            "growth must not leak outside top edge"
        );
        assert_eq!(
            dilated[3 * image_width as usize + 6],
            255,
            "original seed should remain"
        );
        assert_eq!(
            dilated[5 * image_width as usize + 8],
            255,
            "growth should happen inside selection"
        );
    }

    #[test]
    fn auto_mask_keeps_disconnected_marks_for_small_corner_selection() {
        let image_width = 200;
        let image_height = 160;
        let mut pixels = Vec::new();

        for _ in 0..image_width * image_height {
            pixels.extend_from_slice(&[120, 120, 120, 255]);
        }

        for (start_x, start_y) in [(150, 144), (182, 147)] {
            for y in start_y..start_y + 3 {
                for x in start_x..start_x + 3 {
                    let index = ((y as usize * image_width as usize) + x as usize) * RGBA_CHANNELS;
                    pixels[index..index + RGBA_CHANNELS].copy_from_slice(&[245, 245, 245, 255]);
                }
            }
        }

        let selection = SelectionRect {
            x: 136,
            y: 140,
            width: 58,
            height: 14,
        };

        let mask =
            refine_rect_mask_by_local_contrast(&pixels, image_width, image_height, selection)
                .expect("small corner selection should produce a refined mask");

        assert_eq!(
            mask[145 * image_width as usize + 151],
            255,
            "first separated mark should be included"
        );
        assert_eq!(
            mask[148 * image_width as usize + 183],
            255,
            "second separated mark should be included"
        );
        assert_eq!(
            mask[145 * image_width as usize + 170],
            0,
            "gap between separated marks should not be filled"
        );
    }

    #[test]
    fn soften_repair_edges_only_corrects_obvious_boundary_spikes() {
        let image_width = 6;
        let image_height = 1;
        let mut pixels = Vec::new();

        for value in [0_u8, 20, 40, 100, 80, 100] {
            pixels.extend_from_slice(&[value, value, value, 255]);
        }

        let mask = vec![0_u8, 0, 255, 255, 0, 0];
        soften_repair_edges(&mut pixels, &mask, image_width, image_height);

        assert_eq!(
            read_rgba_pixel(&pixels, image_width, 2, 0),
            [40, 40, 40, 255]
        );
        assert_eq!(
            read_rgba_pixel(&pixels, image_width, 3, 0),
            [60, 60, 60, 255]
        );
    }

    #[test]
    fn gradient_repair_handles_smooth_corner_mask() {
        let image_width = 5;
        let image_height = 5;
        let mut pixels = Vec::new();

        for y in 0..image_height {
            for x in 0..image_width {
                let value = 20 + x as u8 * 10 + y as u8 * 6;
                pixels.extend_from_slice(&[value, value, value, 255]);
            }
        }

        let mut mask = vec![0_u8; (image_width * image_height) as usize];
        for y in 3..image_height {
            for x in 3..image_width {
                mask[y as usize * image_width as usize + x as usize] = 255;
            }
        }

        assert!(should_use_gradient_repair(
            &pixels,
            &mask,
            image_width,
            image_height
        ));
        repair_mask_with_gradient_fill(&mut pixels, &mask, image_width, image_height)
            .expect("gradient repair should succeed");

        let inner = read_rgba_pixel(&pixels, image_width, 3, 3);
        let repaired = read_rgba_pixel(&pixels, image_width, 4, 4);
        assert!(
            repaired[0] >= 56 && repaired[0] <= 70,
            "unexpected corner value: {}",
            repaired[0]
        );
        assert!(
            repaired[0] >= inner[0],
            "corner should not reverse the gradient"
        );
    }

    #[test]
    fn create_unique_output_path_skips_existing_files() {
        let temp_dir = TestDir::new();
        let input = temp_dir.path.join("sample.png");
        let existing = temp_dir.path.join("sample_no_watermark.png");
        let next = temp_dir.path.join("sample_no_watermark-2.png");

        fs::write(&input, "input").expect("write input");
        fs::write(&existing, "existing").expect("write existing");

        let candidate = create_unique_output_path(&input, "_no_watermark");
        assert_eq!(candidate, next);
    }
}
