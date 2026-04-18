use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::AppHandle;

use super::ffmpeg_utils::{get_ffmpeg_path, get_ffprobe_path};
use super::logger::{log_error, log_info};

#[derive(Debug, Serialize, Deserialize)]
pub struct CropResult {
    pub success: bool,
    pub output_path: String,
    pub message: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ImageInfo {
    pub width: u32,
    pub height: u32,
    pub path: String,
    pub thumbnail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrushStroke {
    pub x: f64,
    pub y: f64,
    #[serde(default = "default_brush_size")]
    pub size: u32,
    #[serde(default)]
    pub erase: bool,
    #[serde(default)]
    pub start: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SelectionRect {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
}

#[derive(Clone)]
struct MaskComponent {
    pixels: Vec<(u32, u32)>,
    min_x: u32,
    max_x: u32,
    min_y: u32,
    max_y: u32,
}

const RGBA_CHANNELS: usize = 4;
const MAX_TEXTURE_SEARCH_STEPS: i32 = 96;
const EDGE_BLEND_TRIGGER_DELTA: u32 = 72;
const GRADIENT_REPAIR_ITERATIONS: usize = 96;
const SMOOTH_BORDER_MAX_STDDEV: f32 = 34.0;
const AUTO_MASK_LOCAL_RADIUS: u32 = 4;
const AUTO_MASK_STRONG_LUMA_DELTA: i32 = 18;
const AUTO_MASK_WEAK_LUMA_DELTA: i32 = 10;
const AUTO_MASK_MIN_PIXELS: usize = 6;
const AUTO_MASK_COMPONENT_GAP_X: u32 = 28;
const AUTO_MASK_COMPONENT_GAP_Y: u32 = 18;

fn default_brush_size() -> u32 {
    24
}

fn build_temp_thumbnail_path() -> PathBuf {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("thumb_{}_{}.jpg", std::process::id(), unique))
}

fn build_temp_mask_path() -> PathBuf {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!(
        "watermark-mask_{}_{}.pgm",
        std::process::id(),
        unique
    ))
}

fn generate_thumbnail(path: &str, app: &AppHandle) -> Result<String, String> {
    let ffmpeg = get_ffmpeg_path(app);
    let temp_path = build_temp_thumbnail_path();

    let output = Command::new(&ffmpeg)
        .args([
            "-y",
            "-i",
            path,
            "-vf",
            "scale=400:-1",
            "-q:v",
            "5",
            temp_path.to_string_lossy().as_ref(),
        ])
        .output()
        .map_err(|error| format!("生成缩略图失败: {}", error))?;

    if !output.status.success() {
        return Err("生成缩略图失败".to_string());
    }

    let data = fs::read(&temp_path).map_err(|error| format!("读取缩略图失败: {}", error))?;
    let _ = fs::remove_file(&temp_path);

    let base64_str = general_purpose::STANDARD.encode(&data);
    Ok(format!("data:image/jpeg;base64,{}", base64_str))
}

fn probe_image_dimensions(app: &AppHandle, path: &str) -> Result<(u32, u32), String> {
    let ffprobe = get_ffprobe_path(app);
    let output = Command::new(&ffprobe)
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height",
            "-of",
            "csv=p=0:s=x",
            path,
        ])
        .output()
        .map_err(|error| format!("获取图片信息失败: {}", error))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ffprobe 错误: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let parts: Vec<&str> = stdout.trim().split('x').collect();
    let (width, height) = if parts.len() >= 2 {
        (
            parts[0].parse().unwrap_or(0_u32),
            parts[1].parse().unwrap_or(0_u32),
        )
    } else {
        (0, 0)
    };

    if width == 0 || height == 0 {
        return Err("无法获取图片尺寸".to_string());
    }

    Ok((width, height))
}

fn normalize_selection_bounds(
    image_width: u32,
    image_height: u32,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
) -> Result<SelectionRect, String> {
    if image_width == 0 || image_height == 0 {
        return Err("图片尺寸无效".to_string());
    }
    if width == 0 || height == 0 {
        return Err("选区尺寸无效".to_string());
    }
    if x >= image_width || y >= image_height {
        return Err("选区超出图片范围".to_string());
    }

    let width = width.min(image_width.saturating_sub(x));
    let height = height.min(image_height.saturating_sub(y));

    if width == 0 || height == 0 {
        return Err("选区超出图片范围".to_string());
    }

    Ok(SelectionRect {
        x,
        y,
        width,
        height,
    })
}

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

    while candidate == input || candidate.exists() {
        candidate = parent.join(format!("{}{}-{}{}", stem, suffix, index, extension));
        index += 1;
    }

    candidate
}

fn escape_filter_path(path: &Path) -> String {
    let normalized = path.to_string_lossy().replace('\\', "/");
    let escaped = normalized
        .replace('\\', "\\\\")
        .replace(':', "\\:")
        .replace('\'', "\\'");
    format!("filename='{}'", escaped)
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

fn fill_rect(mask: &mut [u8], image_width: u32, rect: SelectionRect, value: u8) {
    let image_width = image_width as usize;
    for row in rect.y..rect.y + rect.height {
        let row_offset = row as usize * image_width;
        for column in rect.x..rect.x + rect.width {
            mask[row_offset + column as usize] = value;
        }
    }
}

fn brush_diameter(stroke: &BrushStroke, default_size: u32) -> u32 {
    if stroke.size == 0 {
        default_size.max(1)
    } else {
        stroke.size.max(1)
    }
}

fn paint_brush_circle(
    mask: &mut [u8],
    image_width: u32,
    image_height: u32,
    x: f64,
    y: f64,
    diameter: u32,
    value: u8,
) {
    let image_width_usize = image_width as usize;
    let radius = diameter as f64 / 2.0;
    let radius_sq = radius * radius;
    let min_x = (x - radius).floor().max(0.0) as u32;
    let max_x = (x + radius).ceil().min((image_width - 1) as f64) as u32;
    let min_y = (y - radius).floor().max(0.0) as u32;
    let max_y = (y + radius).ceil().min((image_height - 1) as f64) as u32;

    for row in min_y..=max_y {
        let row_offset = row as usize * image_width_usize;
        for column in min_x..=max_x {
            let dx = column as f64 + 0.5 - x;
            let dy = row as f64 + 0.5 - y;
            if dx * dx + dy * dy <= radius_sq {
                mask[row_offset + column as usize] = value;
            }
        }
    }
}

fn paint_brush_segment(
    mask: &mut [u8],
    image_width: u32,
    image_height: u32,
    from: &BrushStroke,
    to: &BrushStroke,
    default_size: u32,
) {
    let diameter = brush_diameter(from, default_size).max(brush_diameter(to, default_size));
    let value = if to.erase { 0 } else { 255 };
    let dx = to.x - from.x;
    let dy = to.y - from.y;
    let distance = (dx * dx + dy * dy).sqrt();

    if distance <= f64::EPSILON {
        paint_brush_circle(mask, image_width, image_height, to.x, to.y, diameter, value);
        return;
    }

    let step = (diameter as f64 / 4.0).max(1.0);
    let steps = (distance / step).ceil().max(1.0) as u32;

    for index in 0..=steps {
        let progress = index as f64 / steps as f64;
        let x = from.x + dx * progress;
        let y = from.y + dy * progress;
        paint_brush_circle(mask, image_width, image_height, x, y, diameter, value);
    }
}

fn apply_brush_strokes(
    mask: &mut [u8],
    image_width: u32,
    image_height: u32,
    strokes: &[BrushStroke],
    default_size: u32,
) {
    if image_width == 0 || image_height == 0 {
        return;
    }

    let mut previous_stroke: Option<&BrushStroke> = None;

    for stroke in strokes {
        let should_connect =
            previous_stroke.is_some_and(|previous| !stroke.start && previous.erase == stroke.erase);

        if let Some(previous) = previous_stroke {
            if should_connect {
                paint_brush_segment(
                    mask,
                    image_width,
                    image_height,
                    previous,
                    stroke,
                    default_size,
                );
            } else {
                let diameter = brush_diameter(stroke, default_size);
                let value = if stroke.erase { 0 } else { 255 };
                paint_brush_circle(
                    mask,
                    image_width,
                    image_height,
                    stroke.x,
                    stroke.y,
                    diameter,
                    value,
                );
            }
        } else {
            let diameter = brush_diameter(stroke, default_size);
            let value = if stroke.erase { 0 } else { 255 };
            paint_brush_circle(
                mask,
                image_width,
                image_height,
                stroke.x,
                stroke.y,
                diameter,
                value,
            );
        }

        previous_stroke = Some(stroke);
    }
}

fn build_repair_mask(
    image_width: u32,
    image_height: u32,
    selection: SelectionRect,
    use_rect_base: bool,
    strokes: &[BrushStroke],
    default_size: u32,
) -> Vec<u8> {
    let mut mask = vec![0_u8; image_width as usize * image_height as usize];
    if use_rect_base {
        fill_rect(&mut mask, image_width, selection, 255);
    }
    apply_brush_strokes(&mut mask, image_width, image_height, strokes, default_size);
    mask
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
    let anchor = components.first()?;
    if anchor.pixels.len() < AUTO_MASK_MIN_PIXELS {
        return None;
    }

    let mut selected_mask = vec![0_u8; image_width as usize * image_height as usize];
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

    let refined = dilate_mask_within_selection(&refined, image_width, image_height, selection, 1);
    let refined_count = refined.iter().filter(|value| **value > 0).count();
    if refined_count < AUTO_MASK_MIN_PIXELS || refined_count * 3 >= selection_area * 2 {
        return None;
    }

    Some(refined)
}

fn write_mask_file(
    path: &Path,
    image_width: u32,
    image_height: u32,
    mask: &[u8],
) -> Result<(), String> {
    let mut output = format!("P5\n{} {}\n255\n", image_width, image_height).into_bytes();
    output.extend_from_slice(mask);
    fs::write(path, output).map_err(|error| format!("写入修复蒙版失败: {}", error))
}

fn rgba_index(image_width: u32, x: u32, y: u32) -> usize {
    ((y as usize * image_width as usize) + x as usize) * RGBA_CHANNELS
}

fn read_rgba_pixel(pixels: &[u8], image_width: u32, x: u32, y: u32) -> [u8; 4] {
    let index = rgba_index(image_width, x, y);
    [
        pixels[index],
        pixels[index + 1],
        pixels[index + 2],
        pixels[index + 3],
    ]
}

fn write_rgba_pixel(pixels: &mut [u8], image_width: u32, x: u32, y: u32, color: [u8; 4]) {
    let index = rgba_index(image_width, x, y);
    pixels[index..index + RGBA_CHANNELS].copy_from_slice(&color);
}

fn color_delta(left: [u8; 4], right: [u8; 4]) -> u32 {
    let red = (left[0] as i32 - right[0] as i32).unsigned_abs();
    let green = (left[1] as i32 - right[1] as i32).unsigned_abs();
    let blue = (left[2] as i32 - right[2] as i32).unsigned_abs();
    let alpha = (left[3] as i32 - right[3] as i32).unsigned_abs() / 4;
    red + green + blue + alpha
}

fn luma(color: [u8; 4]) -> i32 {
    ((color[0] as i32 * 77) + (color[1] as i32 * 150) + (color[2] as i32 * 29)) / 256
}

fn blend_colors(left: [u8; 4], right: [u8; 4], left_distance: i32, right_distance: i32) -> [u8; 4] {
    let total = (left_distance + right_distance).max(1) as u32;
    let left_weight = right_distance.max(1) as u32;
    let right_weight = left_distance.max(1) as u32;
    let mix = |channel: usize| -> u8 {
        (((left[channel] as u32 * left_weight) + (right[channel] as u32 * right_weight)) / total)
            .min(255) as u8
    };

    [mix(0), mix(1), mix(2), mix(3)]
}

fn has_known_neighbor(known: &[bool], image_width: u32, image_height: u32, x: u32, y: u32) -> bool {
    let min_x = x.saturating_sub(1);
    let max_x = (x + 1).min(image_width.saturating_sub(1));
    let min_y = y.saturating_sub(1);
    let max_y = (y + 1).min(image_height.saturating_sub(1));

    for neighbor_y in min_y..=max_y {
        for neighbor_x in min_x..=max_x {
            if neighbor_x == x && neighbor_y == y {
                continue;
            }
            let index = neighbor_y as usize * image_width as usize + neighbor_x as usize;
            if known[index] {
                return true;
            }
        }
    }

    false
}

fn collect_neighbor_colors(
    pixels: &[u8],
    known: &[bool],
    image_width: u32,
    image_height: u32,
    x: u32,
    y: u32,
) -> Vec<[u8; 4]> {
    let min_x = x.saturating_sub(1);
    let max_x = (x + 1).min(image_width.saturating_sub(1));
    let min_y = y.saturating_sub(1);
    let max_y = (y + 1).min(image_height.saturating_sub(1));
    let mut colors = Vec::new();

    for neighbor_y in min_y..=max_y {
        for neighbor_x in min_x..=max_x {
            if neighbor_x == x && neighbor_y == y {
                continue;
            }
            let index = neighbor_y as usize * image_width as usize + neighbor_x as usize;
            if known[index] {
                colors.push(read_rgba_pixel(pixels, image_width, neighbor_x, neighbor_y));
            }
        }
    }

    colors
}

fn compatibility_score(candidate: [u8; 4], neighbors: &[[u8; 4]]) -> u32 {
    if neighbors.is_empty() {
        return 0;
    }

    neighbors
        .iter()
        .map(|neighbor| color_delta(candidate, *neighbor))
        .sum::<u32>()
        / neighbors.len() as u32
}

fn mean_neighbor_color(
    pixels: &[u8],
    image_width: u32,
    image_height: u32,
    x: u32,
    y: u32,
) -> Option<[u8; 4]> {
    let min_x = x.saturating_sub(1);
    let max_x = (x + 1).min(image_width.saturating_sub(1));
    let min_y = y.saturating_sub(1);
    let max_y = (y + 1).min(image_height.saturating_sub(1));
    let mut channels = [0_u32; 4];
    let mut count = 0_u32;

    for neighbor_y in min_y..=max_y {
        for neighbor_x in min_x..=max_x {
            if neighbor_x == x && neighbor_y == y {
                continue;
            }
            let color = read_rgba_pixel(pixels, image_width, neighbor_x, neighbor_y);
            for channel in 0..4 {
                channels[channel] += color[channel] as u32;
            }
            count += 1;
        }
    }

    if count == 0 {
        None
    } else {
        Some([
            (channels[0] / count) as u8,
            (channels[1] / count) as u8,
            (channels[2] / count) as u8,
            (channels[3] / count) as u8,
        ])
    }
}

fn blend_pixel(current: [u8; 4], target: [u8; 4], numerator: u32, denominator: u32) -> [u8; 4] {
    let retain = denominator.saturating_sub(numerator);
    let mix = |channel: usize| -> u8 {
        (((current[channel] as u32 * retain) + (target[channel] as u32 * numerator)) / denominator)
            .min(255) as u8
    };

    [mix(0), mix(1), mix(2), mix(3)]
}

#[allow(clippy::too_many_arguments)]
fn find_nearest_known_in_direction(
    known: &[bool],
    image_width: u32,
    image_height: u32,
    x: u32,
    y: u32,
    dx: i32,
    dy: i32,
    max_steps: i32,
) -> Option<(u32, u32, i32)> {
    let mut next_x = x as i32;
    let mut next_y = y as i32;

    for step in 1..=max_steps {
        next_x += dx;
        next_y += dy;

        if next_x < 0 || next_y < 0 || next_x >= image_width as i32 || next_y >= image_height as i32
        {
            return None;
        }

        let index = next_y as usize * image_width as usize + next_x as usize;
        if known[index] {
            return Some((next_x as u32, next_y as u32, step));
        }
    }

    None
}

fn choose_texture_fill_color(
    pixels: &[u8],
    known: &[bool],
    image_width: u32,
    image_height: u32,
    x: u32,
    y: u32,
) -> Option<[u8; 4]> {
    let max_steps = MAX_TEXTURE_SEARCH_STEPS.min(image_width.max(image_height) as i32);
    let neighbors = collect_neighbor_colors(pixels, known, image_width, image_height, x, y);

    let left =
        find_nearest_known_in_direction(known, image_width, image_height, x, y, -1, 0, max_steps);
    let right =
        find_nearest_known_in_direction(known, image_width, image_height, x, y, 1, 0, max_steps);
    let up =
        find_nearest_known_in_direction(known, image_width, image_height, x, y, 0, -1, max_steps);
    let down =
        find_nearest_known_in_direction(known, image_width, image_height, x, y, 0, 1, max_steps);

    let mut pair_candidates = Vec::new();

    if let (Some((left_x, left_y, left_distance)), Some((right_x, right_y, right_distance))) =
        (left, right)
    {
        let left_color = read_rgba_pixel(pixels, image_width, left_x, left_y);
        let right_color = read_rgba_pixel(pixels, image_width, right_x, right_y);
        let blended = blend_colors(left_color, right_color, left_distance, right_distance);
        let score = color_delta(left_color, right_color)
            + compatibility_score(blended, &neighbors)
            + (left_distance + right_distance) as u32 * 2;
        pair_candidates.push((blended, score));
    }

    if let (Some((up_x, up_y, up_distance)), Some((down_x, down_y, down_distance))) = (up, down) {
        let up_color = read_rgba_pixel(pixels, image_width, up_x, up_y);
        let down_color = read_rgba_pixel(pixels, image_width, down_x, down_y);
        let blended = blend_colors(up_color, down_color, up_distance, down_distance);
        let score = color_delta(up_color, down_color)
            + compatibility_score(blended, &neighbors)
            + (up_distance + down_distance) as u32 * 2;
        pair_candidates.push((blended, score));
    }

    if let Some((best_color, _)) = pair_candidates.into_iter().min_by_key(|(_, score)| *score) {
        return Some(best_color);
    }

    let mut best_candidate: Option<([u8; 4], u32)> = None;
    let directions = [
        (-1, 0),
        (1, 0),
        (0, -1),
        (0, 1),
        (-1, -1),
        (1, -1),
        (-1, 1),
        (1, 1),
    ];

    for (dx, dy) in directions {
        if let Some((source_x, source_y, distance)) = find_nearest_known_in_direction(
            known,
            image_width,
            image_height,
            x,
            y,
            dx,
            dy,
            max_steps,
        ) {
            let candidate = read_rgba_pixel(pixels, image_width, source_x, source_y);
            let diagonal_penalty = if dx != 0 && dy != 0 { 6 } else { 0 };
            let score = compatibility_score(candidate, &neighbors)
                + distance as u32 * 12
                + diagonal_penalty;

            match best_candidate {
                Some((_, best_score)) if best_score <= score => {}
                _ => best_candidate = Some((candidate, score)),
            }
        }
    }

    best_candidate.map(|(candidate, _)| candidate)
}

fn compute_mask_distances(mask: &[u8], image_width: u32, image_height: u32) -> Vec<u16> {
    let mut distances = vec![u16::MAX; mask.len()];
    let mut queue = VecDeque::new();

    for y in 0..image_height {
        for x in 0..image_width {
            let index = y as usize * image_width as usize + x as usize;
            if mask[index] == 0 {
                continue;
            }

            let min_x = x.saturating_sub(1);
            let max_x = (x + 1).min(image_width.saturating_sub(1));
            let min_y = y.saturating_sub(1);
            let max_y = (y + 1).min(image_height.saturating_sub(1));

            let mut touches_outside = false;
            'neighbors: for neighbor_y in min_y..=max_y {
                for neighbor_x in min_x..=max_x {
                    if neighbor_x == x && neighbor_y == y {
                        continue;
                    }
                    let neighbor_index =
                        neighbor_y as usize * image_width as usize + neighbor_x as usize;
                    if mask[neighbor_index] == 0 {
                        touches_outside = true;
                        break 'neighbors;
                    }
                }
            }

            if touches_outside {
                distances[index] = 0;
                queue.push_back((x, y));
            }
        }
    }

    while let Some((x, y)) = queue.pop_front() {
        let index = y as usize * image_width as usize + x as usize;
        let next_distance = distances[index].saturating_add(1);
        let min_x = x.saturating_sub(1);
        let max_x = (x + 1).min(image_width.saturating_sub(1));
        let min_y = y.saturating_sub(1);
        let max_y = (y + 1).min(image_height.saturating_sub(1));

        for neighbor_y in min_y..=max_y {
            for neighbor_x in min_x..=max_x {
                let neighbor_index =
                    neighbor_y as usize * image_width as usize + neighbor_x as usize;
                if mask[neighbor_index] == 0 || distances[neighbor_index] <= next_distance {
                    continue;
                }
                distances[neighbor_index] = next_distance;
                queue.push_back((neighbor_x, neighbor_y));
            }
        }
    }

    distances
}

fn soften_repair_edges(pixels: &mut [u8], mask: &[u8], image_width: u32, image_height: u32) {
    let distances = compute_mask_distances(mask, image_width, image_height);
    let source = pixels.to_vec();

    for y in 0..image_height {
        for x in 0..image_width {
            let index = y as usize * image_width as usize + x as usize;
            if mask[index] == 0 {
                continue;
            }

            let distance = distances[index];
            if distance > 1 {
                continue;
            }

            let Some(target) = mean_neighbor_color(&source, image_width, image_height, x, y) else {
                continue;
            };
            let current = read_rgba_pixel(&source, image_width, x, y);
            let delta = color_delta(current, target);

            if delta <= EDGE_BLEND_TRIGGER_DELTA {
                continue;
            }

            let blended = if distance == 0 {
                target
            } else {
                blend_pixel(current, target, 1, 2)
            };

            write_rgba_pixel(pixels, image_width, x, y, blended);
        }
    }
}

fn mask_touches_image_border(mask: &[u8], image_width: u32, image_height: u32) -> bool {
    for x in 0..image_width {
        if mask[x as usize] > 0
            || mask[((image_height - 1) as usize * image_width as usize) + x as usize] > 0
        {
            return true;
        }
    }

    for y in 0..image_height {
        if mask[y as usize * image_width as usize] > 0
            || mask[(y as usize * image_width as usize) + (image_width - 1) as usize] > 0
        {
            return true;
        }
    }

    false
}

fn collect_boundary_pixels(mask: &[u8], image_width: u32, image_height: u32) -> Vec<(u32, u32)> {
    let mut boundary = Vec::new();

    for y in 0..image_height {
        for x in 0..image_width {
            let index = y as usize * image_width as usize + x as usize;
            if mask[index] > 0 {
                continue;
            }

            let min_x = x.saturating_sub(1);
            let max_x = (x + 1).min(image_width.saturating_sub(1));
            let min_y = y.saturating_sub(1);
            let max_y = (y + 1).min(image_height.saturating_sub(1));

            let mut adjacent_to_mask = false;
            'neighbors: for neighbor_y in min_y..=max_y {
                for neighbor_x in min_x..=max_x {
                    if neighbor_x == x && neighbor_y == y {
                        continue;
                    }
                    let neighbor_index =
                        neighbor_y as usize * image_width as usize + neighbor_x as usize;
                    if mask[neighbor_index] > 0 {
                        adjacent_to_mask = true;
                        break 'neighbors;
                    }
                }
            }

            if adjacent_to_mask {
                boundary.push((x, y));
            }
        }
    }

    boundary
}

fn boundary_color_stddev(pixels: &[u8], mask: &[u8], image_width: u32, image_height: u32) -> f32 {
    let boundary = collect_boundary_pixels(mask, image_width, image_height);
    if boundary.is_empty() {
        return f32::MAX;
    }

    let mut sums = [0_f32; 3];
    for (x, y) in &boundary {
        let color = read_rgba_pixel(pixels, image_width, *x, *y);
        sums[0] += color[0] as f32;
        sums[1] += color[1] as f32;
        sums[2] += color[2] as f32;
    }

    let count = boundary.len() as f32;
    let means = [sums[0] / count, sums[1] / count, sums[2] / count];
    let mut variance = 0_f32;

    for (x, y) in &boundary {
        let color = read_rgba_pixel(pixels, image_width, *x, *y);
        for channel in 0..3 {
            let diff = color[channel] as f32 - means[channel];
            variance += diff * diff;
        }
    }

    (variance / (count * 3.0)).sqrt()
}

fn should_use_gradient_repair(
    pixels: &[u8],
    mask: &[u8],
    image_width: u32,
    image_height: u32,
) -> bool {
    if !mask_touches_image_border(mask, image_width, image_height) {
        return false;
    }

    boundary_color_stddev(pixels, mask, image_width, image_height) <= SMOOTH_BORDER_MAX_STDDEV
}

fn repair_mask_with_gradient_fill(
    pixels: &mut [u8],
    mask: &[u8],
    image_width: u32,
    image_height: u32,
) -> Result<(), String> {
    let boundary = collect_boundary_pixels(mask, image_width, image_height);
    if boundary.is_empty() {
        return Err("缺少可用于重建的边界像素".to_string());
    }

    let mut channel_sums = [0_u64; 4];
    for (x, y) in &boundary {
        let color = read_rgba_pixel(pixels, image_width, *x, *y);
        for channel in 0..4 {
            channel_sums[channel] += color[channel] as u64;
        }
    }

    let count = boundary.len() as u64;
    let seed = [
        (channel_sums[0] / count) as u8,
        (channel_sums[1] / count) as u8,
        (channel_sums[2] / count) as u8,
        (channel_sums[3] / count) as u8,
    ];

    let mut current = pixels.to_vec();
    let mut next = current.clone();
    let mut masked_pixels = Vec::new();

    for y in 0..image_height {
        for x in 0..image_width {
            let index = y as usize * image_width as usize + x as usize;
            if mask[index] > 0 {
                write_rgba_pixel(&mut current, image_width, x, y, seed);
                write_rgba_pixel(&mut next, image_width, x, y, seed);
                masked_pixels.push((x, y));
            }
        }
    }

    if masked_pixels.is_empty() {
        return Ok(());
    }

    for _ in 0..GRADIENT_REPAIR_ITERATIONS {
        let mut max_delta = 0_u32;

        for (x, y) in &masked_pixels {
            let min_x = x.saturating_sub(1);
            let max_x = (*x + 1).min(image_width.saturating_sub(1));
            let min_y = y.saturating_sub(1);
            let max_y = (*y + 1).min(image_height.saturating_sub(1));
            let mut sums = [0_u32; 4];
            let mut weights = 0_u32;

            for neighbor_y in min_y..=max_y {
                for neighbor_x in min_x..=max_x {
                    if neighbor_x == *x && neighbor_y == *y {
                        continue;
                    }

                    let diagonal = neighbor_x != *x && neighbor_y != *y;
                    let weight = if diagonal { 1_u32 } else { 2_u32 };
                    let color = read_rgba_pixel(&current, image_width, neighbor_x, neighbor_y);
                    for channel in 0..4 {
                        sums[channel] += color[channel] as u32 * weight;
                    }
                    weights += weight;
                }
            }

            if weights == 0 {
                continue;
            }

            let updated = [
                (sums[0] / weights) as u8,
                (sums[1] / weights) as u8,
                (sums[2] / weights) as u8,
                (sums[3] / weights) as u8,
            ];
            let previous = read_rgba_pixel(&current, image_width, *x, *y);
            max_delta = max_delta.max(color_delta(previous, updated));
            write_rgba_pixel(&mut next, image_width, *x, *y, updated);
        }

        std::mem::swap(&mut current, &mut next);
        if max_delta <= 2 {
            break;
        }
    }

    for (x, y) in masked_pixels {
        let color = read_rgba_pixel(&current, image_width, x, y);
        write_rgba_pixel(pixels, image_width, x, y, color);
    }

    Ok(())
}

fn repair_mask_with_texture_fill(
    pixels: &mut [u8],
    mask: &[u8],
    image_width: u32,
    image_height: u32,
) -> Result<(), String> {
    if mask.len() != image_width as usize * image_height as usize {
        return Err("修复蒙版尺寸与图片不匹配".to_string());
    }

    let mut known = mask.iter().map(|value| *value == 0).collect::<Vec<_>>();
    let mut queued = vec![false; known.len()];
    let mut queue = VecDeque::new();

    for y in 0..image_height {
        for x in 0..image_width {
            let index = y as usize * image_width as usize + x as usize;
            if !known[index] && has_known_neighbor(&known, image_width, image_height, x, y) {
                queue.push_back((x, y));
                queued[index] = true;
            }
        }
    }

    while let Some((x, y)) = queue.pop_front() {
        let index = y as usize * image_width as usize + x as usize;
        queued[index] = false;

        if known[index] {
            continue;
        }

        if !has_known_neighbor(&known, image_width, image_height, x, y) {
            continue;
        }

        let Some(color) =
            choose_texture_fill_color(pixels, &known, image_width, image_height, x, y)
        else {
            continue;
        };

        write_rgba_pixel(pixels, image_width, x, y, color);
        known[index] = true;

        let min_x = x.saturating_sub(1);
        let max_x = (x + 1).min(image_width.saturating_sub(1));
        let min_y = y.saturating_sub(1);
        let max_y = (y + 1).min(image_height.saturating_sub(1));

        for neighbor_y in min_y..=max_y {
            for neighbor_x in min_x..=max_x {
                let neighbor_index =
                    neighbor_y as usize * image_width as usize + neighbor_x as usize;
                if !known[neighbor_index] && !queued[neighbor_index] {
                    queue.push_back((neighbor_x, neighbor_y));
                    queued[neighbor_index] = true;
                }
            }
        }
    }

    if known.iter().all(|value| *value) {
        Ok(())
    } else {
        Err("修复区域过大或缺少可参考的周边像素".to_string())
    }
}

fn decode_image_rgba(
    app: &AppHandle,
    path: &str,
    image_width: u32,
    image_height: u32,
) -> Result<Vec<u8>, String> {
    let ffmpeg = get_ffmpeg_path(app);
    let output = Command::new(&ffmpeg)
        .args([
            "-v",
            "error",
            "-i",
            path,
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgba",
            "-frames:v",
            "1",
            "pipe:1",
        ])
        .output()
        .map_err(|error| format!("读取图片像素失败: {}", error))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("读取图片像素失败: {}", stderr));
    }

    let expected_size = image_width as usize * image_height as usize * RGBA_CHANNELS;
    if output.stdout.len() != expected_size {
        return Err(format!(
            "读取图片像素失败: 实际输出 {} 字节，期望 {} 字节",
            output.stdout.len(),
            expected_size
        ));
    }

    Ok(output.stdout)
}

fn encode_image_rgba(
    app: &AppHandle,
    pixels: &[u8],
    image_width: u32,
    image_height: u32,
    output_path: &Path,
) -> Result<(), String> {
    let ffmpeg = get_ffmpeg_path(app);
    let expected_size = image_width as usize * image_height as usize * RGBA_CHANNELS;
    if pixels.len() != expected_size {
        return Err("输出像素尺寸无效".to_string());
    }

    let mut child = Command::new(&ffmpeg)
        .args([
            "-y",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgba",
            "-video_size",
            &format!("{}x{}", image_width, image_height),
            "-i",
            "pipe:0",
            "-frames:v",
            "1",
            "-q:v",
            "1",
            output_path.to_string_lossy().as_ref(),
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("写出修复结果失败: {}", error))?;

    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(pixels)
            .map_err(|error| format!("写出修复结果失败: {}", error))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|error| format!("写出修复结果失败: {}", error))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("写出修复结果失败: {}", stderr))
    }
}

fn run_texture_repair(
    app: &AppHandle,
    pixels: &mut [u8],
    output_path: &Path,
    mask: &[u8],
    image_width: u32,
    image_height: u32,
) -> Result<(), String> {
    if should_use_gradient_repair(pixels, mask, image_width, image_height) {
        log_info("[去水印] repair 使用平滑背景重建");
        repair_mask_with_gradient_fill(pixels, mask, image_width, image_height)?;
    } else {
        log_info("[去水印] repair 使用纹理修补算法");
        repair_mask_with_texture_fill(pixels, mask, image_width, image_height)?;
    }
    soften_repair_edges(pixels, mask, image_width, image_height);
    encode_image_rgba(app, pixels, image_width, image_height, output_path)
}

fn run_ffmpeg_repair_fallback(
    ffmpeg: &Path,
    input_path: &str,
    output_path: &Path,
    mask: &[u8],
    image_width: u32,
    image_height: u32,
) -> Result<(), String> {
    let mask_path = build_temp_mask_path();
    let result = (|| -> Result<(), String> {
        write_mask_file(&mask_path, image_width, image_height, mask)?;
        let filter = format!("removelogo={}", escape_filter_path(&mask_path));

        let output = Command::new(ffmpeg)
            .args([
                "-y",
                "-i",
                input_path,
                "-vf",
                &filter,
                "-q:v",
                "1",
                output_path.to_string_lossy().as_ref(),
            ])
            .output()
            .map_err(|error| format!("处理失败: {}", error))?;

        if output.status.success() {
            Ok(())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(format!("处理失败: {}", stderr))
        }
    })();

    let _ = fs::remove_file(&mask_path);
    result
}

#[tauri::command]
pub fn get_image_info(app: AppHandle, path: String) -> Result<ImageInfo, String> {
    log_info(&format!("[去水印] 获取图片信息: {}", path));

    let input = Path::new(&path);
    if !input.exists() {
        log_error(&format!("[去水印] 文件不存在: {}", path));
        return Err("文件不存在".to_string());
    }

    let (width, height) = probe_image_dimensions(&app, &path).map_err(|error| {
        log_error(&format!("[去水印] {}", error));
        error
    })?;

    log_info(&format!("[去水印] 图片尺寸: {}x{}", width, height));

    let thumbnail = generate_thumbnail(&path, &app).unwrap_or_default();

    Ok(ImageInfo {
        width,
        height,
        path,
        thumbnail,
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn remove_watermark(
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
    let input = Path::new(&input_path);
    if !input.exists() {
        return Err("文件不存在".to_string());
    }

    let (image_width, image_height) = probe_image_dimensions(&app, &input_path)?;
    let selection = normalize_selection_bounds(image_width, image_height, x, y, width, height)?;
    let ffmpeg = get_ffmpeg_path(&app);
    let output_path = create_unique_output_path(input, "_no_watermark");

    log_info(&format!(
        "[去水印] 开始处理: mode={}, rect=({}, {}, {}, {}), output={}",
        mode,
        selection.x,
        selection.y,
        selection.width,
        selection.height,
        output_path.display()
    ));

    let fill_opacity = clamp_fill_opacity(fill_opacity);
    let blur_strength = clamp_blur_strength(blur_strength);
    let fill_alpha = fill_opacity as f32 / 100.0;

    let ffmpeg_color = if let Some(color) = color.strip_prefix('#') {
        format!("0x{}@{:.2}", color, fill_alpha)
    } else {
        format!("{}@{:.2}", color, fill_alpha)
    };

    match mode.as_str() {
        "repair" => {
            let use_rect_base = uses_rect_base(repair_base_mode.as_deref());
            let mut mask = build_repair_mask(
                image_width,
                image_height,
                selection,
                use_rect_base,
                &brush_strokes,
                brush_size.max(1),
            );
            if !mask.iter().any(|pixel| *pixel > 0) {
                return Err("请先框选或涂抹要修复的区域".to_string());
            }

            match decode_image_rgba(&app, &input_path, image_width, image_height) {
                Ok(mut pixels) => {
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

                    if let Err(error) = run_texture_repair(
                        &app,
                        &mut pixels,
                        &output_path,
                        &mask,
                        image_width,
                        image_height,
                    ) {
                        log_error(&format!(
                            "[去水印] 纹理修补失败，回退到 FFmpeg removelogo: {}",
                            error
                        ));
                        run_ffmpeg_repair_fallback(
                            &ffmpeg,
                            &input_path,
                            &output_path,
                            &mask,
                            image_width,
                            image_height,
                        )?;
                    }
                }
                Err(error) => {
                    log_error(&format!(
                        "[去水印] 读取像素失败，回退到 FFmpeg removelogo: {}",
                        error
                    ));
                    run_ffmpeg_repair_fallback(
                        &ffmpeg,
                        &input_path,
                        &output_path,
                        &mask,
                        image_width,
                        image_height,
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

            let output = Command::new(&ffmpeg)
                .args([
                    "-y",
                    "-i",
                    &input_path,
                    "-filter_complex",
                    &filter,
                    "-q:v",
                    "1",
                    output_path.to_string_lossy().as_ref(),
                ])
                .output()
                .map_err(|error| format!("处理失败: {}", error))?;

            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                log_error(&format!("[去水印] 处理失败: {}", stderr));
                return Err(format!("处理失败: {}", stderr));
            }
        }
        _ => {
            let filter = format!(
                "drawbox=x={}:y={}:w={}:h={}:color={}:t=fill",
                selection.x, selection.y, selection.width, selection.height, ffmpeg_color
            );

            let output = Command::new(&ffmpeg)
                .args([
                    "-y",
                    "-i",
                    &input_path,
                    "-vf",
                    &filter,
                    "-q:v",
                    "1",
                    output_path.to_string_lossy().as_ref(),
                ])
                .output()
                .map_err(|error| format!("处理失败: {}", error))?;

            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                log_error(&format!("[去水印] 处理失败: {}", stderr));
                return Err(format!("处理失败: {}", stderr));
            }
        }
    }

    Ok(CropResult {
        success: true,
        output_path: output_path.to_string_lossy().to_string(),
        message: format!("已保存到: {}", output_path.display()),
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn batch_remove_watermark(
    app: AppHandle,
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
) -> Result<Vec<CropResult>, String> {
    let mut results = Vec::new();

    for path in input_paths {
        if let (Some(expected_width), Some(expected_height)) = (expected_width, expected_height) {
            match probe_image_dimensions(&app, &path) {
                Ok((actual_width, actual_height)) => {
                    if actual_width != expected_width || actual_height != expected_height {
                        results.push(CropResult {
                            success: false,
                            output_path: String::new(),
                            message: format!(
                                "{}: 尺寸不匹配，当前为 {}x{}，期望 {}x{}",
                                path, actual_width, actual_height, expected_width, expected_height
                            ),
                        });
                        continue;
                    }
                }
                Err(error) => {
                    results.push(CropResult {
                        success: false,
                        output_path: String::new(),
                        message: format!("{}: {}", path, error),
                    });
                    continue;
                }
            }
        }

        match remove_watermark(
            app.clone(),
            path.clone(),
            x,
            y,
            width,
            height,
            color.clone(),
            fill_opacity,
            blur_strength,
            mode.clone(),
            repair_base_mode.clone(),
            brush_strokes.clone(),
            brush_size.max(1),
        ) {
            Ok(result) => results.push(result),
            Err(error) => results.push(CropResult {
                success: false,
                output_path: String::new(),
                message: format!("{}: {}", path, error),
            }),
        }
    }

    Ok(results)
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
