use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct Vec3 {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind")]
pub enum CurveSeg {
    #[serde(rename = "line")]
    Line { p1: Vec3, p2: Vec3 },
    #[serde(rename = "arc")]
    Arc { p1: Vec3, pm: Vec3, p2: Vec3 },
    #[serde(rename = "circle")]
    Circle { center: Vec3, radius: f64 },
}

#[derive(Debug, Clone, Deserialize)]
pub struct ContourLoop {
    pub segs: Vec<CurveSeg>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CutOp {
    pub op_kind: String, // "groove" | "pocket" | "rabbet" | "moulding"
    pub name: String,
    pub center: Vec3,
    pub entry: Vec3,
    pub ax_x: Vec3,
    pub ax_y: Vec3,
    pub tpl_ax_x: Vec3,
    pub tpl_ax_y: Vec3,
    pub lx: f64,
    pub ly: f64,
    pub lz: f64,
    pub box_wmm: f64,
    pub box_lmm: f64,
    pub width_mm: f64,
    pub length_mm: f64,
    pub depth_mm: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HoleOp {
    pub entry: Vec3,
    pub start: Vec3,
    pub dir: Vec3,
    pub ax_x: Vec3,
    pub ax_y: Vec3,
    pub tpl_ax_x: Vec3,
    pub tpl_ax_y: Vec3,
    pub diam_mm: f64,
    pub depth_mm: f64,
    pub radius: f64,
    pub length: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelData {
    pub uid_name: String,
    pub name: String,
    pub art_pos: String,
    pub material: String,
    pub thickness_mm: f64,
    pub edges_summary: String,
    pub edge_count: i32,
    pub layer: i32,
    pub is_rect: bool,
    pub outer_loop: Option<ContourLoop>,
    #[serde(default)]
    pub inner_loops: Vec<ContourLoop>,
    pub center: Vec3,
    pub ax_x: Vec3,
    pub ax_y: Vec3,
    pub ax_z: Vec3,
    pub lx: f64,
    pub ly: f64,
    pub lz: f64,
    #[serde(default)]
    pub cuts: Vec<CutOp>,
    #[serde(default)]
    pub holes: Vec<HoleOp>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareItem {
    pub name: String,
    pub safe_name: String,
    #[serde(default)]
    pub article: String,
    #[serde(default)]
    pub supplier: String,
    #[serde(default)]
    pub shape_kind: String, // "box" | "cylinder"
    pub origin: Vec3,
    pub ax_x: Vec3,
    pub ax_y: Vec3,
    #[serde(default = "default_vec3_zero")]
    pub center_local: Vec3,
    #[serde(default = "default_hw_dim")]
    pub lx: f64,
    #[serde(default = "default_hw_dim")]
    pub ly: f64,
    #[serde(default = "default_hw_dim")]
    pub lz: f64,
    #[serde(default)]
    pub connected_panels: Vec<String>,
}

fn default_vec3_zero() -> Vec3 {
    Vec3 { x: 0.0, y: 0.0, z: 0.0 }
}

fn default_hw_dim() -> f64 {
    0.02
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BazisExportModel {
    pub model_name: String,
    #[serde(default)]
    pub templates_dir: String,
    #[serde(default)]
    pub hardware_lib_dir: String,
    #[serde(default)]
    pub save_top_path: String,
    pub panels: Vec<PanelData>,
    #[serde(default)]
    pub hardware: Vec<HardwareItem>,
}

impl BazisExportModel {
    pub fn total_cuts(&self) -> usize {
        self.panels.iter().map(|p| p.cuts.len()).sum()
    }

    pub fn total_holes(&self) -> usize {
        self.panels.iter().map(|p| p.holes.len()).sum()
    }
}
