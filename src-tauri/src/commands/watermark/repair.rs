use std::collections::VecDeque;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::AppHandle;

use super::super::logger::log_info;
use super::super::process::ProcessSlot;
use super::image_io::encode_image_rgba;

pub(super) const RGBA_CHANNELS: usize = 4;
const MAX_TEXTURE_SEARCH_STEPS: i32 = 96;
const EDGE_BLEND_TRIGGER_DELTA: u32 = 72;
const GRADIENT_REPAIR_ITERATIONS: usize = 96;
const SMOOTH_BORDER_MAX_STDDEV: f32 = 34.0;

fn rgba_index(image_width: u32, x: u32, y: u32) -> usize {
    ((y as usize * image_width as usize) + x as usize) * RGBA_CHANNELS
}

pub(super) fn read_rgba_pixel(pixels: &[u8], image_width: u32, x: u32, y: u32) -> [u8; 4] {
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

pub(super) fn luma(color: [u8; 4]) -> i32 {
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

pub(super) fn soften_repair_edges(
    pixels: &mut [u8],
    mask: &[u8],
    image_width: u32,
    image_height: u32,
) {
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

pub(super) fn should_use_gradient_repair(
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

#[cfg(test)]
pub(super) fn repair_mask_with_gradient_fill(
    pixels: &mut [u8],
    mask: &[u8],
    image_width: u32,
    image_height: u32,
) -> Result<(), String> {
    repair_mask_with_gradient_fill_cancellable(pixels, mask, image_width, image_height, None)
}

fn repair_mask_with_gradient_fill_cancellable(
    pixels: &mut [u8],
    mask: &[u8],
    image_width: u32,
    image_height: u32,
    cancelled: Option<&AtomicBool>,
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
        ensure_repair_not_cancelled(cancelled)?;
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
        ensure_repair_not_cancelled(cancelled)?;
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

#[cfg(test)]
pub(super) fn repair_mask_with_texture_fill(
    pixels: &mut [u8],
    mask: &[u8],
    image_width: u32,
    image_height: u32,
) -> Result<(), String> {
    repair_mask_with_texture_fill_cancellable(pixels, mask, image_width, image_height, None)
}

fn repair_mask_with_texture_fill_cancellable(
    pixels: &mut [u8],
    mask: &[u8],
    image_width: u32,
    image_height: u32,
    cancelled: Option<&AtomicBool>,
) -> Result<(), String> {
    if mask.len() != image_width as usize * image_height as usize {
        return Err("修复蒙版尺寸与图片不匹配".to_string());
    }

    let mut known = mask.iter().map(|value| *value == 0).collect::<Vec<_>>();
    let mut queued = vec![false; known.len()];
    let mut queue = VecDeque::new();

    for y in 0..image_height {
        ensure_repair_not_cancelled(cancelled)?;
        for x in 0..image_width {
            let index = y as usize * image_width as usize + x as usize;
            if !known[index] && has_known_neighbor(&known, image_width, image_height, x, y) {
                queue.push_back((x, y));
                queued[index] = true;
            }
        }
    }

    let mut processed = 0usize;
    while let Some((x, y)) = queue.pop_front() {
        processed += 1;
        if processed.is_multiple_of(1024) {
            ensure_repair_not_cancelled(cancelled)?;
        }
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

#[allow(clippy::too_many_arguments)]
pub(super) fn run_texture_repair(
    app: &AppHandle,
    pixels: &mut [u8],
    output_path: &Path,
    mask: &[u8],
    image_width: u32,
    image_height: u32,
    process_slot: Option<&ProcessSlot>,
    cancelled: Option<&AtomicBool>,
) -> Result<(), String> {
    ensure_repair_not_cancelled(cancelled)?;
    if should_use_gradient_repair(pixels, mask, image_width, image_height) {
        log_info("[去水印] repair 使用平滑背景重建");
        repair_mask_with_gradient_fill_cancellable(
            pixels,
            mask,
            image_width,
            image_height,
            cancelled,
        )?;
    } else {
        log_info("[去水印] repair 使用纹理修补算法");
        repair_mask_with_texture_fill_cancellable(
            pixels,
            mask,
            image_width,
            image_height,
            cancelled,
        )?;
    }
    ensure_repair_not_cancelled(cancelled)?;
    soften_repair_edges(pixels, mask, image_width, image_height);
    ensure_repair_not_cancelled(cancelled)?;
    encode_image_rgba(
        app,
        pixels,
        image_width,
        image_height,
        output_path,
        process_slot,
        cancelled,
    )
}

fn ensure_repair_not_cancelled(cancelled: Option<&AtomicBool>) -> Result<(), String> {
    if cancelled
        .map(|flag| flag.load(Ordering::SeqCst))
        .unwrap_or(false)
    {
        Err("操作已取消".into())
    } else {
        Ok(())
    }
}
