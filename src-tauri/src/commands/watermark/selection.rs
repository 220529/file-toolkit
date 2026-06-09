#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct SelectionRect {
    pub(super) x: u32,
    pub(super) y: u32,
    pub(super) width: u32,
    pub(super) height: u32,
}

pub(super) fn normalize_selection_bounds(
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
