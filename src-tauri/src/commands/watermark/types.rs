use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct CropResult {
    pub success: bool,
    pub output_path: String,
    pub message: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WatermarkBatchResult {
    pub cancelled: bool,
    pub items: Vec<CropResult>,
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

fn default_brush_size() -> u32 {
    24
}
