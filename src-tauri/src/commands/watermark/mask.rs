use super::selection::SelectionRect;
use super::types::BrushStroke;

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

pub(super) fn apply_brush_strokes(
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

pub(super) fn build_repair_mask(
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
