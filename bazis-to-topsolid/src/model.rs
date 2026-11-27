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
pub struct EdgeBandData {
    pub elem_index: i32,
    #[serde(default)]
    pub side_tag: String, // "L1" | "L2" | "W1" | "W2" | "ARC_E..." | "E..."
    pub material: String,
    #[serde(default)]
    pub code: String,
    pub thickness_mm: f64,
    #[serde(default)]
    pub width_mm: f64,
    #[serde(default)]
    pub length_mm: f64,
    #[serde(default)]
    pub overhung_mm: f64,
    #[serde(default)]
    pub clip_panel: bool,
    #[serde(default)]
    pub sign: String,
    #[serde(default = "default_vec3_zero")]
    pub mid_point: Vec3,
    #[serde(default = "default_vec3_zero")]
    pub out_normal: Vec3,
    pub strip_loop: Option<ContourLoop>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelData {
    pub uid_name: String,
    pub name: String,
    pub art_pos: String,
    pub material: String,
    #[serde(default)]
    pub selected: bool,
    pub thickness_mm: f64,
    pub edges_summary: String,
    pub edge_count: i32,
    #[serde(default)]
    pub edge_total_len_mm: f64,
    #[serde(default)]
    pub edges: Vec<EdgeBandData>,
    pub layer: i32,
    pub is_rect: bool,
    pub outer_loop: Option<ContourLoop>,
    #[serde(default)]
    pub inner_loops: Vec<ContourLoop>,
    pub center: Vec3,
    #[serde(default)]
    pub nominal_center: Option<Vec3>,
    pub ax_x: Vec3,
    pub ax_y: Vec3,
    pub ax_z: Vec3,
    pub lx: f64,
    pub ly: f64,
    #[serde(default)]
    pub nominal_lx: f64,
    #[serde(default)]
    pub nominal_ly: f64,
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
    #[serde(default)]
    pub selected: bool,
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
pub struct SweepSeg {
    pub kind: String, // "extrude" | "revolve"
    pub profile_loop: ContourLoop,
    pub ax_x: Vec3,
    pub ax_y: Vec3,
    #[serde(default = "default_vec3_zero")]
    pub dir: Vec3,
    #[serde(default)]
    pub length: f64,
    #[serde(default = "default_vec3_zero")]
    pub axis_origin: Vec3,
    #[serde(default = "default_vec3_zero")]
    pub axis_dir: Vec3,
    #[serde(default)]
    pub angle_rad: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Body3D {
    pub kind: String, // "extrusion" | "revolve" | "sweep" | "pyramid" | "sphere" | "box" | "csg"
    pub name: String,
    #[serde(default)]
    pub material: String,
    #[serde(default)]
    pub selected: bool,
    #[serde(default)]
    pub outer_loop: Option<ContourLoop>,
    #[serde(default)]
    pub top_loop: Option<ContourLoop>,
    #[serde(default)]
    pub inner_loops: Vec<ContourLoop>,
    #[serde(default = "default_vec3_zero")]
    pub center: Vec3,
    #[serde(default = "default_vec3_zero")]
    pub ax_x: Vec3,
    #[serde(default = "default_vec3_zero")]
    pub ax_y: Vec3,
    #[serde(default = "default_vec3_zero")]
    pub dir: Vec3,
    #[serde(default)]
    pub lx: f64,
    #[serde(default)]
    pub ly: f64,
    #[serde(default)]
    pub lz: f64,
    #[serde(default)]
    pub length: f64,
    #[serde(default)]
    pub radius: f64,
    #[serde(default = "default_vec3_zero")]
    pub axis_origin: Vec3,
    #[serde(default = "default_vec3_zero")]
    pub axis_dir: Vec3,
    #[serde(default)]
    pub angle_rad: f64,
    #[serde(default)]
    pub segments: Vec<SweepSeg>,
    #[serde(default)]
    pub csg_op: i32, // 0=subtract, 1=union, 2=intersect
    #[serde(default)]
    pub operands: Vec<Body3D>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterialDef {
    pub name: String,
    #[serde(default)]
    pub code: String,
    #[serde(default)]
    pub category: String, // "panel" | "edge" | "other"
    #[serde(default)]
    pub thickness_mm: f64,
    #[serde(default)]
    pub width_mm: f64,
    #[serde(default)]
    pub length_mm: f64,
    #[serde(default)]
    pub density: f64,
    #[serde(default = "default_color_comp")]
    pub color_r: f64,
    #[serde(default = "default_color_comp")]
    pub color_g: f64,
    #[serde(default = "default_color_comp")]
    pub color_b: f64,
    #[serde(default)]
    pub reflection: f64,
    #[serde(default)]
    pub transparency: f64,
    #[serde(default)]
    pub texture_path: String,
    #[serde(default)]
    pub texture_name: String,
    #[serde(default)]
    pub has_grain: bool,
}

fn default_color_comp() -> f64 {
    0.85
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
    pub bodies: Vec<Body3D>,
    #[serde(default)]
    pub hardware: Vec<HardwareItem>,
    #[serde(default)]
    pub materials: Vec<MaterialDef>,
}

impl BazisExportModel {
    pub fn total_cuts(&self) -> usize {
        self.panels.iter().map(|p| p.cuts.len()).sum()
    }

    pub fn total_holes(&self) -> usize {
        self.panels.iter().map(|p| p.holes.len()).sum()
    }

    pub fn selected_counts(&self) -> (usize, usize, usize) {
        let sp = self.panels.iter().filter(|p| p.selected).count();
        let sb = self.bodies.iter().filter(|b| b.selected).count();
        let sh = self.hardware.iter().filter(|h| h.selected).count();
        (sp, sb, sh)
    }

    pub fn filter_selected(&self) -> BazisExportModel {
        let mut out = self.clone();
        out.panels.retain(|p| p.selected);
        out.bodies.retain(|b| b.selected);
        out.hardware.retain(|h| h.selected);
        out
    }
}
