#![cfg(windows)]

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::sleep;
use std::time::Duration;

use crate::com::{ComArg, ComGuard, ComObj};
use crate::model::{BazisExportModel, ContourLoop, CurveSeg, Vec3};
use crate::win_ui::{apply_use_process_batch, modify_active_doc_params};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportMode {
    NativeTemplates,
    FastParasolid,
}

#[derive(Debug, Clone)]
pub struct ExportStats {
    pub panels: usize,
    pub shaped: usize,
    pub cutouts: usize,
    pub cuts: usize,
    pub holes: usize,
    pub variants_built: usize,
    pub native_applied: usize,
    pub errors: usize,
    pub saved_path: Option<String>,
}

struct VariantSpec {
    src: String,
    dst: String,
    params: Vec<(String, String, f64)>, // (name, "35mm" UI fallback, 0.035 meters for ASCII patch)
}

fn fmt_meters(m: f64) -> String {
    let s = format!("{:.6}", m);
    let trimmed = s.trim_end_matches('0').trim_end_matches('.');
    if trimmed.is_empty() || trimmed == "-0" {
        "0".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Patch {D_PARAM driver values directly in an ASCII-format TopSolid .top template.
/// Returns Ok(true) if the file is ASCII and all requested parameters were patched,
/// or Ok(false) if the source template is binary/compressed (caller should use UI fallback).
fn patch_ascii_top_params(
    src: &str,
    dst: &str,
    params: &[(String, String, f64)],
) -> Result<bool, String> {
    let raw = fs::read(src).map_err(|e| format!("Read {} failed: {}", src, e))?;
    if !raw.starts_with(b"[TOP\r\n") && !raw.starts_with(b"[TOP\n") {
        return Ok(false);
    }
    let text: String = raw.iter().map(|&b| b as char).collect();
    let mut lines: Vec<String> = text
        .split('\n')
        .map(|l| l.trim_end_matches('\r').to_string())
        .collect();

    // Update embedded $FILENAME self-reference if present
    for l in &mut lines {
        if l.eq_ignore_ascii_case(src) {
            *l = dst.to_string();
        }
    }

    let mut matched = 0usize;
    let mut i = 0usize;
    while i < lines.len() {
        if lines[i] == "{D_PARAM" {
            let mut end = i + 1;
            while end < lines.len() && lines[end] != "}" {
                end += 1;
            }
            if end < lines.len() && i + 28 < end && lines[i + 5] == "S1" {
                let pname = lines[i + 6].as_str();
                if let Some((_, _, val_m)) = params.iter().find(|(k, _, _)| k == pname) {
                    if lines[i + 27].starts_with('R') && lines[i + 28].starts_with('R') {
                        let rval = format!("R{}", fmt_meters(*val_m));
                        lines[i + 27] = rval.clone();
                        lines[i + 28] = rval;
                        matched += 1;
                    }
                }
            }
            i = end + 1;
        } else {
            i += 1;
        }
    }

    if matched != params.len() {
        return Ok(false);
    }

    let out_str = lines.join("\r\n");
    let out_bytes: Vec<u8> = out_str.chars().map(|c| c as u8).collect();
    fs::write(dst, out_bytes).map_err(|e| format!("Write {} failed: {}", dst, e))?;
    Ok(true)
}

fn num_key(n: f64) -> String {
    let rounded = (n * 10.0).round() / 10.0;
    let s = if (rounded - rounded.round()).abs() < 1e-6 {
        format!("{}", rounded.round() as i64)
    } else {
        format!("{:.1}", rounded)
    };
    s.replace('.', "p")
}

fn resolve_templates_dir(hint: &str) -> PathBuf {
    let candidates = [
        hint,
        r"Y:\Works\bazis\TopSolid_Templates",
        r"C:\Users\danch\Documents\Bazis\TopSolid_Templates",
    ];
    for c in candidates {
        if !c.is_empty() && Path::new(c).exists() {
            return PathBuf::from(c);
        }
    }
    PathBuf::from(r"Y:\Works\bazis\TopSolid_Templates")
}

fn find_base_templates(dir: &Path) -> HashMap<String, String> {
    let pairs = [
        ("drill", "B&S_Drill.top"),
        ("groove", "B&S_Groove.top"),
        ("pocket", "B&S_Pocket.top"),
        ("rabbet", "B&S_Rabbet.top"),
        ("moulding", "B&S_Moulding.top"),
    ];
    let mut map = HashMap::new();
    for (k, fname) in pairs {
        let p = dir.join(fname);
        if p.exists() {
            map.insert(k.to_string(), p.to_string_lossy().to_string());
        }
    }
    map
}

fn build_loop_curve(
    curves: &ComObj,
    lp: &ContourLoop,
    ax_x: &Vec3,
    ax_y: &Vec3,
) -> Result<ComObj, String> {
    if lp.segs.len() == 1 {
        if let CurveSeg::Circle { center, radius } = &lp.segs[0] {
            return curves.call_obj(
                "AddBasicCircle",
                &[
                    ComArg::F64(center.x),
                    ComArg::F64(center.y),
                    ComArg::F64(center.z),
                    ComArg::F64(ax_x.x),
                    ComArg::F64(ax_x.y),
                    ComArg::F64(ax_x.z),
                    ComArg::F64(ax_y.x),
                    ComArg::F64(ax_y.y),
                    ComArg::F64(ax_y.z),
                    ComArg::F64(*radius),
                ],
            );
        }
    }
    let mut seg_objs = Vec::with_capacity(lp.segs.len());
    for seg in &lp.segs {
        let obj = match seg {
            CurveSeg::Line { p1, p2 } => curves.call_obj(
                "AddBasicLine",
                &[
                    ComArg::F64(p1.x),
                    ComArg::F64(p1.y),
                    ComArg::F64(p1.z),
                    ComArg::F64(p2.x),
                    ComArg::F64(p2.y),
                    ComArg::F64(p2.z),
                ],
            )?,
            CurveSeg::Arc { p1, pm, p2 } => curves.call_obj(
                "Add3PointsCircle",
                &[
                    ComArg::F64(p1.x),
                    ComArg::F64(p1.y),
                    ComArg::F64(p1.z),
                    ComArg::F64(pm.x),
                    ComArg::F64(pm.y),
                    ComArg::F64(pm.z),
                    ComArg::F64(p2.x),
                    ComArg::F64(p2.y),
                    ComArg::F64(p2.z),
                    ComArg::I32(0),
                ],
            )?,
            CurveSeg::Circle { center, radius } => curves.call_obj(
                "AddBasicCircle",
                &[
                    ComArg::F64(center.x),
                    ComArg::F64(center.y),
                    ComArg::F64(center.z),
                    ComArg::F64(ax_x.x),
                    ComArg::F64(ax_x.y),
                    ComArg::F64(ax_x.z),
                    ComArg::F64(ax_y.x),
                    ComArg::F64(ax_y.y),
                    ComArg::F64(ax_y.z),
                    ComArg::F64(*radius),
                ],
            )?,
        };
        seg_objs.push(obj);
    }
    curves.call_obj(
        "AddBasicComposite",
        &[ComArg::ObjArray(&seg_objs), ComArg::Bool(true)],
    )
}

pub fn run_export<F>(
    model: &BazisExportModel,
    mode: ExportMode,
    auto_save: bool,
    cancel: &AtomicBool,
    mut on_progress: F,
) -> Result<ExportStats, String>
where
    F: FnMut(usize, usize, &str),
{
    let _com = ComGuard::init_sta()?;
    on_progress(0, 100, "Connecting to TopSolid.Application...");
    let app = ComObj::create("TopSolid.Application")?;
    let docs = app.get_obj("Documents")?;

    let tpl_dir = resolve_templates_dir(&model.templates_dir);
    let cache_dir = tpl_dir.join("cache");
    let base_tpls = if mode == ExportMode::NativeTemplates {
        find_base_templates(&tpl_dir)
    } else {
        HashMap::new()
    };

    // Collect unique exact-size native template variants needed by this model
    let mut variant_seen: HashMap<String, bool> = HashMap::new();
    let mut variants: Vec<VariantSpec> = Vec::new();
    if mode == ExportMode::NativeTemplates {
        for p in &model.panels {
            for c in &p.cuts {
                if let Some(src) = base_tpls.get(&c.op_kind) {
                    let (key, params) = if c.op_kind == "pocket" {
                        (
                            format!(
                                "{}x{}x{}",
                                num_key(c.box_wmm),
                                num_key(c.box_lmm),
                                num_key(c.depth_mm)
                            ),
                            vec![
                                ("W".into(), format!("{}mm", c.box_wmm), c.box_wmm * 0.001),
                                ("L".into(), format!("{}mm", c.box_lmm), c.box_lmm * 0.001),
                                ("H".into(), format!("{}mm", c.depth_mm), c.depth_mm * 0.001),
                            ],
                        )
                    } else {
                        (
                            format!(
                                "{}x{}x{}",
                                num_key(c.width_mm),
                                num_key(c.depth_mm),
                                num_key(c.length_mm)
                            ),
                            vec![
                                ("W".into(), format!("{}mm", c.width_mm), c.width_mm * 0.001),
                                ("H".into(), format!("{}mm", c.depth_mm), c.depth_mm * 0.001),
                                ("L".into(), format!("{}mm", c.length_mm), c.length_mm * 0.001),
                            ],
                        )
                    };
                    let dst = cache_dir
                        .join(format!("B&S_{}_{}.top", c.op_kind, key))
                        .to_string_lossy()
                        .to_string();
                    if !variant_seen.contains_key(&dst) {
                        variant_seen.insert(dst.clone(), true);
                        if !Path::new(&dst).exists() {
                            variants.push(VariantSpec {
                                src: src.clone(),
                                dst,
                                params,
                            });
                        }
                    }
                }
            }
            for h in &p.holes {
                if let Some(src) = base_tpls.get("drill") {
                    let key = format!("{}x{}", num_key(h.diam_mm), num_key(h.depth_mm));
                    let dst = cache_dir
                        .join(format!("B&S_drill_{}.top", key))
                        .to_string_lossy()
                        .to_string();
                    if !variant_seen.contains_key(&dst) {
                        variant_seen.insert(dst.clone(), true);
                        if !Path::new(&dst).exists() {
                            variants.push(VariantSpec {
                                src: src.clone(),
                                dst,
                                params: vec![
                                    ("D".into(), format!("{}mm", h.diam_mm), h.diam_mm * 0.001),
                                    ("H".into(), format!("{}mm", h.depth_mm), h.depth_mm * 0.001),
                                ],
                            });
                        }
                    }
                }
            }
        }
    }

    let total_ops = model.total_cuts() + model.total_holes();
    let total_units = variants.len()
        + model.panels.len()
        + total_ops
        + if mode == ExportMode::NativeTemplates {
            total_ops
        } else {
            0
        };
    let total_units = total_units.max(1);
    let mut progress = 0usize;

    let mut stats = ExportStats {
        panels: 0,
        shaped: 0,
        cutouts: 0,
        cuts: 0,
        holes: 0,
        variants_built: 0,
        native_applied: 0,
        errors: 0,
        saved_path: None,
    };

    // Phase 1: Build missing cached exact-size native .top templates
    if !variants.is_empty() {
        fs::create_dir_all(&cache_dir)
            .map_err(|e| format!("Failed to create cache dir {:?}: {}", cache_dir, e))?;
        for v in &variants {
            if cancel.load(Ordering::Relaxed) {
                return Err("Stopped by user during template variant generation.".into());
            }
            on_progress(
                progress,
                total_units,
                &format!("Building cached template: {}", Path::new(&v.dst).file_name().unwrap_or_default().to_string_lossy()),
            );
            let patched_ascii = patch_ascii_top_params(&v.src, &v.dst, &v.params)?;
            if !patched_ascii {
                fs::copy(&v.src, &v.dst)
                    .map_err(|e| format!("Copy {} -> {} failed: {}", v.src, v.dst, e))?;
            }
            let _ = docs.call("Open", &[ComArg::Str(&v.dst)])?;
            sleep(Duration::from_millis(160));
            if !patched_ascii {
                let ui_params: Vec<(String, String)> = v
                    .params
                    .iter()
                    .map(|(k, s, _)| (k.clone(), s.clone()))
                    .collect();
                modify_active_doc_params(&ui_params)?;
            }
            let cur = app.get_obj("CurrentDocument")?;
            let cur_doc = cur.get_obj("Document")?;
            let _ = cur_doc.call("Save", &[])?;
            let _ = cur_doc.call("Close", &[ComArg::Bool(false), ComArg::Bool(false)]);
            stats.variants_built += 1;
            progress += 1;
        }
    }

    // Phase 2: Create new TopSolid design document, build all panels, and place operations
    on_progress(progress, total_units, "Creating new TopSolid'Wood 6.25 document...");
    let doc = docs.call_obj("Add", &[ComArg::Str("top")])?;
    let shapes = doc.get_obj("Shapes")?;
    let curves = doc.get_obj("Curves")?;
    let csystems = doc.get_obj("CoordinateSystems")?;
    let components = doc.get_obj("Components")?;

    let mut apply_pairs: Vec<(String, String)> = Vec::new();
    let mut deferred_layers: Vec<(ComObj, i32)> = Vec::new();
    let mut op_seq: usize = 0;

    for (idx, p) in model.panels.iter().enumerate() {
        if cancel.load(Ordering::Relaxed) {
            return Err(format!("Stopped by user at panel {}/{}.", idx, model.panels.len()));
        }
        on_progress(
            progress,
            total_units,
            &format!("Panel {}/{}: {}", idx + 1, model.panels.len(), p.name),
        );

        let blk_res = if p.is_rect || p.outer_loop.is_none() {
            shapes.call_obj(
                "AddBasicBlock",
                &[
                    ComArg::F64(p.center.x),
                    ComArg::F64(p.center.y),
                    ComArg::F64(p.center.z),
                    ComArg::F64(p.ax_x.x),
                    ComArg::F64(p.ax_x.y),
                    ComArg::F64(p.ax_x.z),
                    ComArg::F64(p.ax_y.x),
                    ComArg::F64(p.ax_y.y),
                    ComArg::F64(p.ax_y.z),
                    ComArg::F64(p.lx),
                    ComArg::F64(p.ly),
                    ComArg::F64(p.lz),
                ],
            )
        } else {
            let lp = p.outer_loop.as_ref().unwrap();
            match build_loop_curve(&curves, lp, &p.ax_x, &p.ax_y) {
                Ok(comp) => {
                    let r = shapes.call_obj(
                        "AddBasicExtruded",
                        &[
                            ComArg::Obj(&comp),
                            ComArg::F64(p.ax_z.x),
                            ComArg::F64(p.ax_z.y),
                            ComArg::F64(p.ax_z.z),
                            ComArg::F64(p.lz),
                            ComArg::F64(0.0),
                            ComArg::F64(0.0),
                            ComArg::Bool(false),
                            ComArg::Bool(true),
                        ],
                    );
                    if r.is_ok() {
                        stats.shaped += 1;
                    }
                    r
                }
                Err(e) => Err(e),
            }
        };

        let blk = match blk_res {
            Ok(b) => b,
            Err(_) => {
                stats.errors += 1;
                progress += 1;
                continue;
            }
        };
        stats.panels += 1;
        progress += 1;

        // Strictly alphanumeric TopSolid element name (no underscores — TopSolid's
        // prompt expression parser rejects underscores during Use process).
        let ts_panel_name = format!("P{}", idx + 1);
        let _ = blk.put("Name", ComArg::Str(&ts_panel_name));
        let _ = blk.put("Designation", ComArg::Str(&p.name));
        if !p.art_pos.is_empty() {
            let _ = blk.put("Reference", ComArg::Str(&p.art_pos));
        }
        if mode == ExportMode::NativeTemplates {
            // Keep panels on visible Layer 0 during Use process; assign final layer after Phase 3
            let _ = blk.put("Layer", ComArg::I32(0));
        } else {
            let _ = blk.put("Layer", ComArg::I32(p.layer));
        }
        let _ = blk.call(
            "SetTextProperty",
            &[ComArg::Str("Bazis_Material"), ComArg::Str(&p.material)],
        );
        let thk_s = format!("{}mm", p.thickness_mm);
        let _ = blk.call(
            "SetTextProperty",
            &[ComArg::Str("Bazis_Thickness"), ComArg::Str(&thk_s)],
        );
        let ec_s = p.edge_count.to_string();
        let _ = blk.call(
            "SetTextProperty",
            &[ComArg::Str("Bazis_EdgeCount"), ComArg::Str(&ec_s)],
        );
        let _ = blk.call(
            "SetTextProperty",
            &[ComArg::Str("Bazis_Edges"), ComArg::Str(&p.edges_summary)],
        );
        if !p.material.is_empty() {
            let _ = blk.call("SetMatter", &[ComArg::Str(&p.material)]);
        }

        // Internal cutouts (shaped panels)
        if !p.inner_loops.is_empty() {
            if let Ok(ops) = blk.get_obj("Operations") {
                for ilp in &p.inner_loops {
                    if let Ok(comp) = build_loop_curve(&curves, ilp, &p.ax_x, &p.ax_y) {
                        if let Ok(tool) = shapes.call_obj(
                            "AddBasicExtruded",
                            &[
                                ComArg::Obj(&comp),
                                ComArg::F64(p.ax_z.x),
                                ComArg::F64(p.ax_z.y),
                                ComArg::F64(p.ax_z.z),
                                ComArg::F64(p.lz + 0.002),
                                ComArg::F64(0.0),
                                ComArg::F64(0.0),
                                ComArg::Bool(false),
                                ComArg::Bool(true),
                            ],
                        ) {
                            if ops
                                .call(
                                    "AddSubtraction",
                                    &[
                                        ComArg::Obj(&tool),
                                        ComArg::NullDispatch,
                                        ComArg::Bool(true),
                                        ComArg::Bool(false),
                                    ],
                                )
                                .is_ok()
                            {
                                stats.cutouts += 1;
                            } else {
                                stats.errors += 1;
                            }
                        }
                    }
                }
            }
        }

        let blk_ops = blk.get_obj("Operations").ok();

        // Cuts (Grooves / Pockets / Rabbets / Mouldings)
        for c in &p.cuts {
            if cancel.load(Ordering::Relaxed) {
                return Err("Stopped by user during cut placement.".into());
            }
            if mode == ExportMode::NativeTemplates && base_tpls.contains_key(&c.op_kind) {
                let key = if c.op_kind == "pocket" {
                    format!(
                        "{}x{}x{}",
                        num_key(c.box_wmm),
                        num_key(c.box_lmm),
                        num_key(c.depth_mm)
                    )
                } else {
                    format!(
                        "{}x{}x{}",
                        num_key(c.width_mm),
                        num_key(c.depth_mm),
                        num_key(c.length_mm)
                    )
                };
                let tpl_file = cache_dir
                    .join(format!("B&S_{}_{}.top", c.op_kind, key))
                    .to_string_lossy()
                    .to_string();
                op_seq += 1;
                let cmp_name = format!("Op{}", op_seq);
                let cs_res = csystems.call_obj(
                    "AddBasic",
                    &[
                        ComArg::F64(c.entry.x),
                        ComArg::F64(c.entry.y),
                        ComArg::F64(c.entry.z),
                        ComArg::F64(c.tpl_ax_x.x),
                        ComArg::F64(c.tpl_ax_x.y),
                        ComArg::F64(c.tpl_ax_x.z),
                        ComArg::F64(c.tpl_ax_y.x),
                        ComArg::F64(c.tpl_ax_y.y),
                        ComArg::F64(c.tpl_ax_y.z),
                    ],
                );
                if let Ok(cs) = cs_res {
                    if let Ok(cmp) = components.call_obj(
                        "AddWithPositioningByCoordinateSystems",
                        &[
                            ComArg::Str(&tpl_file),
                            ComArg::Str("Origin"),
                            ComArg::Obj(&cs),
                        ],
                    ) {
                        if let Ok(el) = cmp.get_obj("Element") {
                            let _ = el.put("Name", ComArg::Str(&cmp_name));
                        }
                        apply_pairs.push((cmp_name, ts_panel_name.clone()));
                        stats.cuts += 1;
                    } else {
                        stats.errors += 1;
                    }
                } else {
                    stats.errors += 1;
                }
            } else if let Some(ref ops) = blk_ops {
                if let Ok(tool) = shapes.call_obj(
                    "AddBasicBlock",
                    &[
                        ComArg::F64(c.center.x),
                        ComArg::F64(c.center.y),
                        ComArg::F64(c.center.z),
                        ComArg::F64(c.ax_x.x),
                        ComArg::F64(c.ax_x.y),
                        ComArg::F64(c.ax_x.z),
                        ComArg::F64(c.ax_y.x),
                        ComArg::F64(c.ax_y.y),
                        ComArg::F64(c.ax_y.z),
                        ComArg::F64(c.lx),
                        ComArg::F64(c.ly),
                        ComArg::F64(c.lz),
                    ],
                ) {
                    let des = format!(
                        "{} {} ({}x{}mm)",
                        c.op_kind.to_uppercase(),
                        c.name,
                        c.width_mm,
                        c.depth_mm
                    );
                    let _ = tool.put("Designation", ComArg::Str(&des));
                    if ops
                        .call(
                            "AddSubtraction",
                            &[
                                ComArg::Obj(&tool),
                                ComArg::NullDispatch,
                                ComArg::Bool(true),
                                ComArg::Bool(false),
                            ],
                        )
                        .is_ok()
                    {
                        stats.cuts += 1;
                    } else {
                        stats.errors += 1;
                    }
                } else {
                    stats.errors += 1;
                }
            }
            progress += 1;
        }

        // Drilling holes
        for h in &p.holes {
            if cancel.load(Ordering::Relaxed) {
                return Err("Stopped by user during hole placement.".into());
            }
            if mode == ExportMode::NativeTemplates && base_tpls.contains_key("drill") {
                let key = format!("{}x{}", num_key(h.diam_mm), num_key(h.depth_mm));
                let tpl_file = cache_dir
                    .join(format!("B&S_drill_{}.top", key))
                    .to_string_lossy()
                    .to_string();
                op_seq += 1;
                let cmp_name = format!("Op{}", op_seq);
                let cs_res = csystems.call_obj(
                    "AddBasic",
                    &[
                        ComArg::F64(h.entry.x),
                        ComArg::F64(h.entry.y),
                        ComArg::F64(h.entry.z),
                        ComArg::F64(h.tpl_ax_x.x),
                        ComArg::F64(h.tpl_ax_x.y),
                        ComArg::F64(h.tpl_ax_x.z),
                        ComArg::F64(h.tpl_ax_y.x),
                        ComArg::F64(h.tpl_ax_y.y),
                        ComArg::F64(h.tpl_ax_y.z),
                    ],
                );
                if let Ok(cs) = cs_res {
                    if let Ok(cmp) = components.call_obj(
                        "AddWithPositioningByCoordinateSystems",
                        &[
                            ComArg::Str(&tpl_file),
                            ComArg::Str("Origin"),
                            ComArg::Obj(&cs),
                        ],
                    ) {
                        if let Ok(el) = cmp.get_obj("Element") {
                            let _ = el.put("Name", ComArg::Str(&cmp_name));
                        }
                        apply_pairs.push((cmp_name, ts_panel_name.clone()));
                        stats.holes += 1;
                    } else {
                        stats.errors += 1;
                    }
                } else {
                    stats.errors += 1;
                }
            } else if let Some(ref ops) = blk_ops {
                if let Ok(circ) = curves.call_obj(
                    "AddBasicCircle",
                    &[
                        ComArg::F64(h.start.x),
                        ComArg::F64(h.start.y),
                        ComArg::F64(h.start.z),
                        ComArg::F64(h.ax_x.x),
                        ComArg::F64(h.ax_x.y),
                        ComArg::F64(h.ax_x.z),
                        ComArg::F64(h.ax_y.x),
                        ComArg::F64(h.ax_y.y),
                        ComArg::F64(h.ax_y.z),
                        ComArg::F64(h.radius),
                    ],
                ) {
                    if let Ok(tool) = shapes.call_obj(
                        "AddBasicExtruded",
                        &[
                            ComArg::Obj(&circ),
                            ComArg::F64(h.dir.x),
                            ComArg::F64(h.dir.y),
                            ComArg::F64(h.dir.z),
                            ComArg::F64(h.length),
                            ComArg::F64(0.0),
                            ComArg::F64(0.0),
                            ComArg::Bool(false),
                            ComArg::Bool(true),
                        ],
                    ) {
                        let des = format!("DRILL D{}x{}mm", h.diam_mm, h.depth_mm);
                        let _ = tool.put("Designation", ComArg::Str(&des));
                        if ops
                            .call(
                                "AddSubtraction",
                                &[
                                    ComArg::Obj(&tool),
                                    ComArg::NullDispatch,
                                    ComArg::Bool(true),
                                    ComArg::Bool(false),
                                ],
                            )
                            .is_ok()
                        {
                            stats.holes += 1;
                        } else {
                            stats.errors += 1;
                        }
                    } else {
                        stats.errors += 1;
                    }
                } else {
                    stats.errors += 1;
                }
            }
            progress += 1;
        }

        if mode == ExportMode::NativeTemplates && p.layer != 0 {
            deferred_layers.push((blk, p.layer));
        }
    }

    // Phase 3: Batch-apply Assembly -> Use process so every panel gets 100% native TopSolid'Wood operations
    if mode == ExportMode::NativeTemplates && !apply_pairs.is_empty() {
        let base_prog = progress;
        stats.native_applied = apply_use_process_batch(&apply_pairs, cancel, |done, _tot, msg| {
            on_progress(base_prog + done, total_units, msg);
        })?;
    }

    // Move panels to their final semantic layers (1=Carcass, 2=Doors, 3=Back, 4=Shelves)
    for (blk, layer) in deferred_layers {
        let _ = blk.put("Layer", ComArg::I32(layer));
    }

    // Optional auto-save .top
    if auto_save && !model.save_top_path.is_empty() {
        on_progress(
            total_units,
            total_units,
            &format!("Saving {}...", model.save_top_path),
        );
        if Path::new(&model.save_top_path).exists() {
            let _ = fs::remove_file(&model.save_top_path);
        }
        if let Ok(doc_file) = doc.get_obj("Document") {
            if doc_file
                .call("SaveAs", &[ComArg::Str(&model.save_top_path)])
                .is_ok()
            {
                stats.saved_path = Some(model.save_top_path.clone());
            }
        }
    }

    on_progress(total_units, total_units, "Export complete.");
    Ok(stats)
}
