#![cfg(windows)]

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::sleep;
use std::time::{Duration, Instant};

use crate::com::{ComArg, ComGuard, ComObj};
use crate::diag_log::{init_log, log_line};
use crate::model::{BazisExportModel, Body3D, ContourLoop, CurveSeg, HardwareItem, HoleOp, SweepSeg, Vec3};
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
    pub hardware_generated: usize,
    pub hardware_placed: usize,
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
            if end < lines.len() && i + 7 < end && lines[i + 5] == "S1" {
                let pname = lines[i + 6].as_str();
                if let Some((_, _, val_m)) = params.iter().find(|(k, _, _)| k == pname) {
                    // Universal offset: first "S0" inside {D_PARAM} is followed at +4 and +5 by the two R<val> lines
                    if let Some(s0) = (i + 7..end).find(|&k| lines[k] == "S0") {
                        if s0 + 5 < end
                            && lines[s0 + 4].starts_with('R')
                            && lines[s0 + 5].starts_with('R')
                        {
                            let rval = format!("R{}", fmt_meters(*val_m));
                            lines[s0 + 4] = rval.clone();
                            lines[s0 + 5] = rval;
                            matched += 1;
                        }
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
        ("drillrow", "B&S_DrillRow.top"),
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

fn v_sub(a: &Vec3, b: &Vec3) -> Vec3 {
    Vec3 { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }
}
fn v_dot(a: &Vec3, b: &Vec3) -> f64 {
    a.x * b.x + a.y * b.y + a.z * b.z
}
fn v_cross(a: &Vec3, b: &Vec3) -> Vec3 {
    Vec3 {
        x: a.y * b.z - a.z * b.y,
        y: a.z * b.x - a.x * b.z,
        z: a.x * b.y - a.y * b.x,
    }
}
fn v_len(a: &Vec3) -> f64 {
    v_dot(a, a).sqrt()
}
fn v_norm(a: &Vec3) -> Vec3 {
    let l = v_len(a);
    if l < 1e-12 { Vec3 { x: 1.0, y: 0.0, z: 0.0 } } else { Vec3 { x: a.x / l, y: a.y / l, z: a.z / l } }
}

enum HoleGroup {
    Single(usize),
    Row {
        entry: Vec3,
        ax_x: Vec3,
        ax_y: Vec3,
        diam_mm: f64,
        depth_mm: f64,
        count: usize,
        step_mm: f64,
    },
}

/// Automatically group collinear equal-step holes of identical diameter, depth, and face normal
/// into universal linear drill rows (N >= 2) so 1 Use process creates the entire row.
fn group_holes_into_rows(holes: &[HoleOp], allow_rows: bool) -> Vec<HoleGroup> {
    if !allow_rows || holes.len() < 2 {
        return (0..holes.len()).map(HoleGroup::Single).collect();
    }
    let n = holes.len();
    let mut used = vec![false; n];
    let mut groups: Vec<HoleGroup> = Vec::new();

    loop {
        let mut best_chain: Vec<usize> = Vec::new();
        let mut best_step: f64 = f64::MAX;
        let mut best_dir = Vec3 { x: 1.0, y: 0.0, z: 0.0 };

        for i in 0..n {
            if used[i] { continue; }
            let hi = &holes[i];
            for j in 0..n {
                if i == j || used[j] { continue; }
                let hj = &holes[j];
                if (hi.diam_mm - hj.diam_mm).abs() > 0.05 || (hi.depth_mm - hj.depth_mm).abs() > 0.05 {
                    continue;
                }
                if v_dot(&hi.dir, &hj.dir) < 0.999 {
                    continue;
                }
                let diff = v_sub(&hj.entry, &hi.entry);
                if v_dot(&diff, &hi.dir).abs() > 0.0005 {
                    continue;
                }
                let step = v_len(&diff);
                if step < 0.003 || step > 1.5 {
                    continue;
                }
                let u = Vec3 { x: diff.x / step, y: diff.y / step, z: diff.z / step };
                // Ensure no unused hole exists one step BEFORE i along -u (so we start from row endpoint)
                let prev_pt = Vec3 {
                    x: hi.entry.x - u.x * step,
                    y: hi.entry.y - u.y * step,
                    z: hi.entry.z - u.z * step,
                };
                let has_prev = (0..n).any(|k| {
                    !used[k]
                        && k != i
                        && (holes[k].diam_mm - hi.diam_mm).abs() <= 0.05
                        && (holes[k].depth_mm - hi.depth_mm).abs() <= 0.05
                        && v_dot(&holes[k].dir, &hi.dir) >= 0.999
                        && v_len(&v_sub(&holes[k].entry, &prev_pt)) < 0.0006
                });
                if has_prev {
                    continue;
                }

                let mut chain = vec![i, j];
                let mut mult = 2usize;
                loop {
                    let target = Vec3 {
                        x: hi.entry.x + u.x * (step * mult as f64),
                        y: hi.entry.y + u.y * (step * mult as f64),
                        z: hi.entry.z + u.z * (step * mult as f64),
                    };
                    let next_idx = (0..n).find(|&k| {
                        !used[k]
                            && !chain.contains(&k)
                            && (holes[k].diam_mm - hi.diam_mm).abs() <= 0.05
                            && (holes[k].depth_mm - hi.depth_mm).abs() <= 0.05
                            && v_dot(&holes[k].dir, &hi.dir) >= 0.999
                            && v_len(&v_sub(&holes[k].entry, &target)) < 0.0006
                    });
                    match next_idx {
                        Some(k) => {
                            chain.push(k);
                            mult += 1;
                        }
                        None => break,
                    }
                }

                if chain.len() > best_chain.len()
                    || (chain.len() == best_chain.len() && chain.len() >= 2 && step < best_step - 1e-5)
                {
                    best_chain = chain;
                    best_step = step;
                    best_dir = u;
                }
            }
        }

        if best_chain.len() < 2 {
            break;
        }
        let h0 = &holes[best_chain[0]];
        let out_z = v_norm(&Vec3 { x: -h0.dir.x, y: -h0.dir.y, z: -h0.dir.z });
        let ax_x = v_norm(&best_dir);
        let ax_y = v_norm(&v_cross(&out_z, &ax_x));
        let step_mm = (best_step * 1000.0 * 10.0).round() / 10.0;
        for &idx in &best_chain {
            used[idx] = true;
        }
        groups.push(HoleGroup::Row {
            entry: h0.entry.clone(),
            ax_x,
            ax_y,
            diam_mm: h0.diam_mm,
            depth_mm: h0.depth_mm,
            count: best_chain.len(),
            step_mm,
        });
    }

    for i in 0..n {
        if !used[i] {
            groups.push(HoleGroup::Single(i));
        }
    }
    groups
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

fn call_basic_revolved(
    shapes: &ComObj,
    comp: &ComObj,
    ox: f64,
    oy: f64,
    oz: f64,
    dx: f64,
    dy: f64,
    dz: f64,
    angle_rad: f64,
) -> Result<ComObj, String> {
    // Verified TopSolid 6 IShapes::AddBasicRevolved = 9 args:
    // (inCurve, ox, oy, oz, dx, dy, dz, angle_rad, closed)
    let full_circle = angle_rad >= std::f64::consts::TAU - 1e-4;
    if full_circle {
        // Split 360° into two 180° closed halves united via AddUnion
        let h1 = shapes.call_obj(
            "AddBasicRevolved",
            &[
                ComArg::Obj(comp),
                ComArg::F64(ox),
                ComArg::F64(oy),
                ComArg::F64(oz),
                ComArg::F64(dx),
                ComArg::F64(dy),
                ComArg::F64(dz),
                ComArg::F64(std::f64::consts::PI),
                ComArg::Bool(true),
            ],
        )?;
        let h2 = shapes.call_obj(
            "AddBasicRevolved",
            &[
                ComArg::Obj(comp),
                ComArg::F64(ox),
                ComArg::F64(oy),
                ComArg::F64(oz),
                ComArg::F64(-dx),
                ComArg::F64(-dy),
                ComArg::F64(-dz),
                ComArg::F64(std::f64::consts::PI),
                ComArg::Bool(true),
            ],
        )?;
        if let Ok(ops) = h1.get_obj("Operations") {
            let _ = ops.call(
                "AddUnion",
                &[
                    ComArg::Obj(&h2),
                    ComArg::NullDispatch,
                    ComArg::Bool(true),
                    ComArg::Bool(false),
                ],
            );
        }
        return Ok(h1);
    }

    shapes.call_obj(
        "AddBasicRevolved",
        &[
            ComArg::Obj(comp),
            ComArg::F64(ox),
            ComArg::F64(oy),
            ComArg::F64(oz),
            ComArg::F64(dx),
            ComArg::F64(dy),
            ComArg::F64(dz),
            ComArg::F64(angle_rad),
            ComArg::Bool(true),
        ],
    )
}

fn build_sweep_segment(
    shapes: &ComObj,
    curves: &ComObj,
    seg: &SweepSeg,
) -> Result<ComObj, String> {
    let comp = build_loop_curve(curves, &seg.profile_loop, &seg.ax_x, &seg.ax_y)?;
    if seg.kind == "revolve" {
        call_basic_revolved(
            shapes,
            &comp,
            seg.axis_origin.x,
            seg.axis_origin.y,
            seg.axis_origin.z,
            seg.axis_dir.x,
            seg.axis_dir.y,
            seg.axis_dir.z,
            seg.angle_rad,
        )
    } else {
        shapes.call_obj(
            "AddBasicExtruded",
            &[
                ComArg::Obj(&comp),
                ComArg::F64(seg.dir.x),
                ComArg::F64(seg.dir.y),
                ComArg::F64(seg.dir.z),
                ComArg::F64(seg.length),
                ComArg::F64(0.0),
                ComArg::F64(0.0),
                ComArg::Bool(false),
                ComArg::Bool(true),
            ],
        )
    }
}

fn build_body_3d(
    shapes: &ComObj,
    curves: &ComObj,
    b: &Body3D,
    ts_name: &str,
) -> Result<ComObj, String> {
    let shape = match b.kind.as_str() {
        "extrusion" => {
            let lp = b
                .outer_loop
                .as_ref()
                .ok_or_else(|| "Extrusion missing outerLoop".to_string())?;
            let comp = build_loop_curve(curves, lp, &b.ax_x, &b.ax_y)?;
            let sh = shapes.call_obj(
                "AddBasicExtruded",
                &[
                    ComArg::Obj(&comp),
                    ComArg::F64(b.dir.x),
                    ComArg::F64(b.dir.y),
                    ComArg::F64(b.dir.z),
                    ComArg::F64(b.length),
                    ComArg::F64(0.0),
                    ComArg::F64(0.0),
                    ComArg::Bool(false),
                    ComArg::Bool(true),
                ],
            )?;
            if !b.inner_loops.is_empty() {
                if let Ok(ops) = sh.get_obj("Operations") {
                    for ilp in &b.inner_loops {
                        if let Ok(icomp) = build_loop_curve(curves, ilp, &b.ax_x, &b.ax_y) {
                            if let Ok(tool) = shapes.call_obj(
                                "AddBasicExtruded",
                                &[
                                    ComArg::Obj(&icomp),
                                    ComArg::F64(b.dir.x),
                                    ComArg::F64(b.dir.y),
                                    ComArg::F64(b.dir.z),
                                    ComArg::F64(b.length + 0.002),
                                    ComArg::F64(0.0),
                                    ComArg::F64(0.0),
                                    ComArg::Bool(false),
                                    ComArg::Bool(true),
                                ],
                            ) {
                                let _ = ops.call(
                                    "AddSubtraction",
                                    &[
                                        ComArg::Obj(&tool),
                                        ComArg::NullDispatch,
                                        ComArg::Bool(true),
                                        ComArg::Bool(false),
                                    ],
                                );
                            }
                        }
                    }
                }
            }
            sh
        }
        "revolve" => {
            let lp = b
                .outer_loop
                .as_ref()
                .ok_or_else(|| "Revolve missing outerLoop".to_string())?;
            let comp = build_loop_curve(curves, lp, &b.ax_x, &b.ax_y)?;
            call_basic_revolved(
                shapes,
                &comp,
                b.axis_origin.x,
                b.axis_origin.y,
                b.axis_origin.z,
                b.axis_dir.x,
                b.axis_dir.y,
                b.axis_dir.z,
                b.angle_rad,
            )?
        }
        "sweep" => {
            if b.segments.is_empty() {
                return Err("Sweep has 0 segments".into());
            }
            let base = build_sweep_segment(shapes, curves, &b.segments[0])?;
            if b.segments.len() > 1 {
                if let Ok(ops) = base.get_obj("Operations") {
                    for seg in &b.segments[1..] {
                        match build_sweep_segment(shapes, curves, seg) {
                            Ok(part) => {
                                if let Err(e) = ops.call(
                                    "AddUnion",
                                    &[
                                        ComArg::Obj(&part),
                                        ComArg::NullDispatch,
                                        ComArg::Bool(true),
                                        ComArg::Bool(false),
                                    ],
                                ) {
                                    log_line(&format!("  SWEEP UNION WARN on {}: {}", ts_name, e));
                                }
                            }
                            Err(e) => {
                                log_line(&format!("  SWEEP SEG ERR on {}: {}", ts_name, e));
                            }
                        }
                    }
                }
            }
            base
        }
        "box" => shapes.call_obj(
            "AddBasicBlock",
            &[
                ComArg::F64(b.center.x),
                ComArg::F64(b.center.y),
                ComArg::F64(b.center.z),
                ComArg::F64(b.ax_x.x),
                ComArg::F64(b.ax_x.y),
                ComArg::F64(b.ax_x.z),
                ComArg::F64(b.ax_y.x),
                ComArg::F64(b.ax_y.y),
                ComArg::F64(b.ax_y.z),
                ComArg::F64(b.lx),
                ComArg::F64(b.ly),
                ComArg::F64(b.lz),
            ],
        )?,
        "sphere" => {
            let r = b.radius.max(0.001);
            let ax_x = v_norm(&b.ax_x);
            let ax_y = v_norm(&b.ax_y);
            let c = &b.center;
            let p_bot = Vec3 { x: c.x - ax_y.x * r, y: c.y - ax_y.y * r, z: c.z - ax_y.z * r };
            let p_mid = Vec3 { x: c.x + ax_x.x * r, y: c.y + ax_x.y * r, z: c.z + ax_x.z * r };
            let p_top = Vec3 { x: c.x + ax_y.x * r, y: c.y + ax_y.y * r, z: c.z + ax_y.z * r };
            let arc = curves.call_obj(
                "Add3PointsCircle",
                &[
                    ComArg::F64(p_bot.x),
                    ComArg::F64(p_bot.y),
                    ComArg::F64(p_bot.z),
                    ComArg::F64(p_mid.x),
                    ComArg::F64(p_mid.y),
                    ComArg::F64(p_mid.z),
                    ComArg::F64(p_top.x),
                    ComArg::F64(p_top.y),
                    ComArg::F64(p_top.z),
                    ComArg::I32(0),
                ],
            )?;
            let axis_ln = curves.call_obj(
                "AddBasicLine",
                &[
                    ComArg::F64(p_top.x),
                    ComArg::F64(p_top.y),
                    ComArg::F64(p_top.z),
                    ComArg::F64(p_bot.x),
                    ComArg::F64(p_bot.y),
                    ComArg::F64(p_bot.z),
                ],
            )?;
            let comp = curves.call_obj(
                "AddBasicComposite",
                &[ComArg::ObjArray(&[arc, axis_ln]), ComArg::Bool(true)],
            )?;
            let ang = if b.angle_rad > 1e-4 { b.angle_rad } else { std::f64::consts::TAU };
            call_basic_revolved(shapes, &comp, c.x, c.y, c.z, ax_y.x, ax_y.y, ax_y.z, ang)?
        }
        "pyramid" => {
            // Exact 5-face closed Parasolid pyramid via intersection of two extruded triangular wedges
            let tri_xz = b
                .outer_loop
                .as_ref()
                .ok_or_else(|| "Pyramid missing outerLoop (triXZ)".to_string())?;
            let tri_yz = b
                .top_loop
                .as_ref()
                .ok_or_else(|| "Pyramid missing topLoop (triYZ)".to_string())?;
            let c1 = build_loop_curve(curves, tri_xz, &b.ax_x, &b.ax_y)?;
            let c2 = build_loop_curve(curves, tri_yz, &b.ax_x, &b.ax_y)?;
            let wedge1 = shapes.call_obj(
                "AddBasicExtruded",
                &[
                    ComArg::Obj(&c1),
                    ComArg::F64(b.ax_y.x),
                    ComArg::F64(b.ax_y.y),
                    ComArg::F64(b.ax_y.z),
                    ComArg::F64(b.ly),
                    ComArg::F64(0.0),
                    ComArg::F64(0.0),
                    ComArg::Bool(false),
                    ComArg::Bool(true),
                ],
            )?;
            let wedge2 = shapes.call_obj(
                "AddBasicExtruded",
                &[
                    ComArg::Obj(&c2),
                    ComArg::F64(b.ax_x.x),
                    ComArg::F64(b.ax_x.y),
                    ComArg::F64(b.ax_x.z),
                    ComArg::F64(b.lx),
                    ComArg::F64(0.0),
                    ComArg::F64(0.0),
                    ComArg::Bool(false),
                    ComArg::Bool(true),
                ],
            )?;
            if let Ok(ops) = wedge1.get_obj("Operations") {
                let _ = ops.call(
                    "AddIntersection",
                    &[
                        ComArg::Obj(&wedge2),
                        ComArg::NullDispatch,
                        ComArg::Bool(true),
                        ComArg::Bool(false),
                    ],
                )?;
            }
            wedge1
        }
        "csg" => {
            if b.operands.is_empty() {
                return Err("CSG operation has 0 operands".into());
            }
            let base = build_body_3d(shapes, curves, &b.operands[0], &format!("{}A", ts_name))?;
            if b.operands.len() > 1 {
                let method = match b.csg_op {
                    0 => "AddSubtraction",
                    1 => "AddUnion",
                    2 => "AddIntersection",
                    _ => "AddUnion",
                };
                if let Ok(ops) = base.get_obj("Operations") {
                    for (oi, op_body) in b.operands[1..].iter().enumerate() {
                        match build_body_3d(shapes, curves, op_body, &format!("{}T{}", ts_name, oi + 1)) {
                            Ok(tool) => {
                                if let Err(e) = ops.call(
                                    method,
                                    &[
                                        ComArg::Obj(&tool),
                                        ComArg::NullDispatch,
                                        ComArg::Bool(true),
                                        ComArg::Bool(false),
                                    ],
                                ) {
                                    log_line(&format!("  CSG {} ERR on {}: {}", method, ts_name, e));
                                }
                            }
                            Err(e) => {
                                log_line(&format!("  CSG OPERAND ERR on {}: {}", ts_name, e));
                            }
                        }
                    }
                }
            }
            base
        }
        other => return Err(format!("Unknown Body3D kind: {}", other)),
    };

    let _ = shape.put("Name", ComArg::Str(ts_name));
    let _ = shape.put("Designation", ComArg::Str(&b.name));
    let _ = shape.put("Layer", ComArg::I32(0));
    if !b.material.is_empty() {
        let _ = shape.call("SetMatter", &[ComArg::Str(&b.material)]);
        let _ = shape.call("SetCoating", &[ComArg::Str(&b.material)]);
    }
    Ok(shape)
}

#[derive(Debug, Clone)]
struct HardwareMapEntry {
    path: String,
    has_process: bool,
}

fn resolve_hardware_lib_dir(model_dir: &str, tpl_dir: &Path) -> PathBuf {
    if !model_dir.is_empty() {
        return PathBuf::from(model_dir);
    }
    if let Some(parent) = tpl_dir.parent() {
        return parent.join("TopSolid_Lib_Bazis");
    }
    PathBuf::from(r"Y:\Works\bazis\TopSolid_Lib_Bazis")
}

/// Load optional `<templates_dir>\hardware_map.json` mapping Bazis hardware names to vendor .top files.
/// Accepts either `"Key": "C:\\path\\file.top"` or `"Key": { "path": "...", "hasProcess": true }`.
fn load_hardware_map(tpl_dir: &Path) -> Vec<(String, HardwareMapEntry)> {
    let map_path = tpl_dir.join("hardware_map.json");
    let Ok(raw) = fs::read_to_string(&map_path) else {
        return Vec::new();
    };
    let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return Vec::new();
    };
    let Some(obj) = val.as_object() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (k, v) in obj {
        if let Some(s) = v.as_str() {
            let p = if Path::new(s).is_absolute() {
                s.to_string()
            } else {
                tpl_dir.join(s).to_string_lossy().to_string()
            };
            out.push((
                k.to_ascii_lowercase(),
                HardwareMapEntry {
                    path: p,
                    has_process: false,
                },
            ));
        } else if let Some(m) = v.as_object() {
            if let Some(s) = m.get("path").and_then(|x| x.as_str()) {
                let p = if Path::new(s).is_absolute() {
                    s.to_string()
                } else {
                    tpl_dir.join(s).to_string_lossy().to_string()
                };
                let has_proc = m.get("hasProcess").and_then(|x| x.as_bool()).unwrap_or(false);
                out.push((
                    k.to_ascii_lowercase(),
                    HardwareMapEntry {
                        path: p,
                        has_process: has_proc,
                    },
                ));
            }
        }
    }
    out
}

/// Stage a .top file from SMB/network storage (e.g. Y:\) into local %TEMP%\ts6_fast_cache\
/// so TopSolid COM AddWithPositioningByCoordinateSystems reads from local SSD (5-10x faster).
fn stage_to_local_cache(src: &str, local_dir: &Path) -> String {
    let sp = Path::new(src);
    let Some(fname) = sp.file_name() else {
        return src.to_string();
    };
    let dst = local_dir.join(fname);
    let need_copy = match (fs::metadata(sp), fs::metadata(&dst)) {
        (Ok(sm), Ok(dm)) => sm.len() != dm.len() || sm.modified().ok() > dm.modified().ok(),
        (Ok(_), Err(_)) => true,
        _ => false,
    };
    if need_copy {
        let _ = fs::create_dir_all(local_dir);
        if fs::copy(sp, &dst).is_ok() {
            return dst.to_string_lossy().to_string();
        }
    } else if dst.exists() {
        return dst.to_string_lossy().to_string();
    }
    src.to_string()
}

/// Transform a local point `(lx, ly, lz)` using hardware origin + orthonormal basis `(ax_x, ax_y, ax_z)`.
fn hw_world_pt(hw: &HardwareItem, lx: f64, ly: f64, lz: f64) -> Vec3 {
    let ax_z = v_norm(&v_cross(&hw.ax_x, &hw.ax_y));
    Vec3 {
        x: hw.origin.x + hw.ax_x.x * lx + hw.ax_y.x * ly + ax_z.x * lz,
        y: hw.origin.y + hw.ax_x.y * lx + hw.ax_y.y * ly + ax_z.y * lz,
        z: hw.origin.z + hw.ax_x.z * lx + hw.ax_y.z * ly + ax_z.z * lz,
    }
}

/// Place generic hardware directly as a lightweight native Parasolid solid (cylinder or block)
/// with full BOM Designation/Reference/Supplier properties (~5 ms per item vs ~1000+ ms for external .top).
fn place_fast_hardware_solid(
    shapes: &ComObj,
    curves: &ComObj,
    hw: &HardwareItem,
    hw_name: &str,
) -> Result<(), String> {
    let lx = hw.lx.clamp(0.004, 2.0);
    let ly = hw.ly.clamp(0.004, 2.0);
    let lz = hw.lz.clamp(0.004, 2.0);
    let cx = hw.center_local.x;
    let cy = hw.center_local.y;
    let cz = hw.center_local.z;
    let ax_x = v_norm(&hw.ax_x);
    let ax_y = v_norm(&hw.ax_y);
    let ax_z = v_norm(&v_cross(&ax_x, &ax_y));

    let body = if hw.shape_kind == "cylinder" {
        let (start, dir, circ_x, circ_y, rad, len) = if lz >= lx && lz >= ly {
            (hw_world_pt(hw, cx, cy, cz - lz * 0.5), ax_z, ax_x, ax_y, (lx.min(ly) * 0.5).max(0.002), lz)
        } else if lx >= ly && lx >= lz {
            (hw_world_pt(hw, cx - lx * 0.5, cy, cz), ax_x, ax_y, ax_z, (ly.min(lz) * 0.5).max(0.002), lx)
        } else {
            (hw_world_pt(hw, cx, cy - ly * 0.5, cz), ax_y, ax_z, ax_x, (lx.min(lz) * 0.5).max(0.002), ly)
        };
        let circ = curves.call_obj(
            "AddBasicCircle",
            &[
                ComArg::F64(start.x),
                ComArg::F64(start.y),
                ComArg::F64(start.z),
                ComArg::F64(circ_x.x),
                ComArg::F64(circ_x.y),
                ComArg::F64(circ_x.z),
                ComArg::F64(circ_y.x),
                ComArg::F64(circ_y.y),
                ComArg::F64(circ_y.z),
                ComArg::F64(rad),
            ],
        )?;
        shapes.call_obj(
            "AddBasicExtruded",
            &[
                ComArg::Obj(&circ),
                ComArg::F64(dir.x),
                ComArg::F64(dir.y),
                ComArg::F64(dir.z),
                ComArg::F64(len),
                ComArg::F64(0.0),
                ComArg::F64(0.0),
                ComArg::Bool(false),
                ComArg::Bool(true),
            ],
        )?
    } else {
        let ctr = hw_world_pt(hw, cx, cy, cz);
        shapes.call_obj(
            "AddBasicBlock",
            &[
                ComArg::F64(ctr.x),
                ComArg::F64(ctr.y),
                ComArg::F64(ctr.z),
                ComArg::F64(hw.ax_x.x),
                ComArg::F64(hw.ax_x.y),
                ComArg::F64(hw.ax_x.z),
                ComArg::F64(hw.ax_y.x),
                ComArg::F64(hw.ax_y.y),
                ComArg::F64(hw.ax_y.z),
                ComArg::F64(lx),
                ComArg::F64(ly),
                ComArg::F64(lz),
            ],
        )?
    };

    let _ = body.put("Name", ComArg::Str(hw_name));
    let _ = body.put("Designation", ComArg::Str(&hw.name));
    if !hw.article.is_empty() {
        let _ = body.put("Reference", ComArg::Str(&hw.article));
    }
    if !hw.supplier.is_empty() {
        let _ = body.put("Supplier", ComArg::Str(&hw.supplier));
    }
    let _ = body.put("Layer", ComArg::I32(0));
    let _ = body.call("SetTextProperty", &[ComArg::Str("Bazis_Hardware"), ComArg::Str(&hw.name)]);
    if !hw.supplier.is_empty() {
        let _ = body.call("SetTextProperty", &[ComArg::Str("Bazis_Supplier"), ComArg::Str(&hw.supplier)]);
    }
    Ok(())
}

fn resolve_hardware_component(
    hw: &HardwareItem,
    hw_map: &[(String, HardwareMapEntry)],
    _hw_lib_dir: &Path,
) -> (Option<String>, bool) {
    let name_low = hw.name.to_ascii_lowercase();
    let safe_low = hw.safe_name.to_ascii_lowercase();
    // Only use external .top components for vendor parts explicitly mapped in hardware_map.json;
    // generic screws/dowels/shelfholders are placed directly as lightweight native Parasolid solids (100x faster).
    for (k, entry) in hw_map {
        if (k == &name_low || k == &safe_low) && Path::new(&entry.path).exists() {
            return (Some(entry.path.clone()), entry.has_process);
        }
    }
    for (k, entry) in hw_map {
        if !k.is_empty()
            && (name_low.contains(k.as_str()) || safe_low.contains(k.as_str()))
            && Path::new(&entry.path).exists()
        {
            return (Some(entry.path.clone()), entry.has_process);
        }
    }
    (None, false)
}

/// Auto-generate a lightweight native TopSolid .top hardware component in `TopSolid_Lib_Bazis`
/// 100% via COM (Origin CS + 3D Parasolid body + BOM Designation/Reference/Supplier, zero UI clicks).
fn generate_hardware_component(
    docs: &ComObj,
    hw: &HardwareItem,
    dst_path: &str,
) -> Result<(), String> {
    let hdoc = docs.call_obj("Add", &[ComArg::Str("top")])?;
    let csystems = hdoc.get_obj("CoordinateSystems")?;
    let shapes = hdoc.get_obj("Shapes")?;

    // Standard Origin CS at (0,0,0) so AddWithPositioningByCoordinateSystems(..., "Origin", cs) works
    let origin_cs = csystems.call_obj(
        "AddBasic",
        &[
            ComArg::F64(0.0),
            ComArg::F64(0.0),
            ComArg::F64(0.0),
            ComArg::F64(1.0),
            ComArg::F64(0.0),
            ComArg::F64(0.0),
            ComArg::F64(0.0),
            ComArg::F64(1.0),
            ComArg::F64(0.0),
        ],
    )?;
    let _ = origin_cs.put("Name", ComArg::Str("Origin"));

    let lx = hw.lx.clamp(0.004, 2.0);
    let ly = hw.ly.clamp(0.004, 2.0);
    let lz = hw.lz.clamp(0.004, 2.0);
    let cx = hw.center_local.x;
    let cy = hw.center_local.y;
    let cz = hw.center_local.z;

    let body_res = if hw.shape_kind == "cylinder" {
        // Align cylinder along its longest local dimension
        let (sx, sy, sz, dx, dy, dz, rad, len) = if lz >= lx && lz >= ly {
            (cx, cy, cz - lz * 0.5, 0.0, 0.0, 1.0, (lx.min(ly) * 0.5).max(0.002), lz)
        } else if lx >= ly && lx >= lz {
            (cx - lx * 0.5, cy, cz, 1.0, 0.0, 0.0, (ly.min(lz) * 0.5).max(0.002), lx)
        } else {
            (cx, cy - ly * 0.5, cz, 0.0, 1.0, 0.0, (lx.min(lz) * 0.5).max(0.002), ly)
        };
        shapes.call_obj(
            "AddBasicCylinder",
            &[
                ComArg::F64(sx),
                ComArg::F64(sy),
                ComArg::F64(sz),
                ComArg::F64(dx),
                ComArg::F64(dy),
                ComArg::F64(dz),
                ComArg::F64(rad),
                ComArg::F64(len),
            ],
        )
    } else {
        shapes.call_obj(
            "AddBasicBlock",
            &[
                ComArg::F64(cx),
                ComArg::F64(cy),
                ComArg::F64(cz),
                ComArg::F64(1.0),
                ComArg::F64(0.0),
                ComArg::F64(0.0),
                ComArg::F64(0.0),
                ComArg::F64(1.0),
                ComArg::F64(0.0),
                ComArg::F64(lx),
                ComArg::F64(ly),
                ComArg::F64(lz),
            ],
        )
    };

    if let Ok(body) = body_res {
        let _ = body.put("Name", ComArg::Str("Body"));
        let _ = body.put("Designation", ComArg::Str(&hw.name));
        if !hw.article.is_empty() {
            let _ = body.put("Reference", ComArg::Str(&hw.article));
        }
        if !hw.supplier.is_empty() {
            let _ = body.put("Supplier", ComArg::Str(&hw.supplier));
        }
        let _ = body.put("Layer", ComArg::I32(0));
        let _ = body.call(
            "SetTextProperty",
            &[ComArg::Str("Bazis_Hardware"), ComArg::Str(&hw.name)],
        );
        if !hw.supplier.is_empty() {
            let _ = body.call(
                "SetTextProperty",
                &[ComArg::Str("Bazis_Supplier"), ComArg::Str(&hw.supplier)],
            );
        }
    }

    let doc_file = hdoc.get_obj("Document")?;
    let _ = doc_file.put("Designation", ComArg::Str(&hw.name));
    if !hw.article.is_empty() {
        let _ = doc_file.put("Reference", ComArg::Str(&hw.article));
    }
    if Path::new(dst_path).exists() {
        let _ = fs::remove_file(dst_path);
    }
    let _ = doc_file.call("SaveAs", &[ComArg::Str(dst_path)])?;
    let _ = doc_file.call("Close", &[ComArg::Bool(false), ComArg::Bool(false)]);
    Ok(())
}

pub fn run_export<F>(
    model: &BazisExportModel,
    mode: ExportMode,
    auto_save: bool,
    include_hardware: bool,
    cancel: &AtomicBool,
    mut on_progress: F,
) -> Result<ExportStats, String>
where
    F: FnMut(usize, usize, &str),
{
    let t_total = Instant::now();
    init_log(&format!(
        "Model='{}' | Mode={:?} | AutoSave={} | IncludeHardware={} | Panels={} | Cuts={} | Holes={} | Hardware={}",
        model.model_name,
        mode,
        auto_save,
        include_hardware,
        model.panels.len(),
        model.total_cuts(),
        model.total_holes(),
        model.hardware.len()
    ));

    let _com = ComGuard::init_sta()?;
    on_progress(0, 100, "Connecting to TopSolid.Application...");
    let app = ComObj::create("TopSolid.Application")?;
    let docs = app.get_obj("Documents")?;
    log_line("Connected to TopSolid.Application COM.");

    let tpl_dir = resolve_templates_dir(&model.templates_dir);
    let cache_dir = tpl_dir.join("cache");
    let base_tpls = if mode == ExportMode::NativeTemplates {
        find_base_templates(&tpl_dir)
    } else {
        HashMap::new()
    };

    let allow_rows = mode == ExportMode::NativeTemplates && base_tpls.contains_key("drillrow");
    let panel_hole_groups: Vec<Vec<HoleGroup>> = model
        .panels
        .iter()
        .map(|p| group_holes_into_rows(&p.holes, allow_rows))
        .collect();
    let total_hole_ops: usize = panel_hole_groups.iter().map(|g| g.len()).sum();

    // Collect unique exact-size native template variants needed by this model
    let mut variant_seen: HashMap<String, bool> = HashMap::new();
    let mut variants: Vec<VariantSpec> = Vec::new();
    if mode == ExportMode::NativeTemplates {
        for (p_idx, p) in model.panels.iter().enumerate() {
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
            for grp in &panel_hole_groups[p_idx] {
                match grp {
                    HoleGroup::Single(hi) => {
                        let h = &p.holes[*hi];
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
                    HoleGroup::Row {
                        diam_mm,
                        depth_mm,
                        count,
                        step_mm,
                        ..
                    } => {
                        if let Some(src) = base_tpls.get("drillrow") {
                            let key = format!(
                                "{}x{}x{}x{}",
                                num_key(*diam_mm),
                                num_key(*depth_mm),
                                count,
                                num_key(*step_mm)
                            );
                            let dst = cache_dir
                                .join(format!("B&S_drillrow_{}.top", key))
                                .to_string_lossy()
                                .to_string();
                            if !variant_seen.contains_key(&dst) {
                                variant_seen.insert(dst.clone(), true);
                                if !Path::new(&dst).exists() {
                                    variants.push(VariantSpec {
                                        src: src.clone(),
                                        dst,
                                        params: vec![
                                            ("D".into(), format!("{}mm", diam_mm), diam_mm * 0.001),
                                            ("H".into(), format!("{}mm", depth_mm), depth_mm * 0.001),
                                            ("N".into(), format!("{}", count), *count as f64),
                                            ("Step".into(), format!("{}mm", step_mm), step_mm * 0.001),
                                        ],
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // Resolve hardware library (only explicit hardware_map.json vendor files use external .top components;
    // generic screws/dowels/shelfholders are placed directly as lightweight Parasolid solids after Phase 3).
    let hw_lib_dir = resolve_hardware_lib_dir(&model.hardware_lib_dir, &tpl_dir);
    let local_cache_dir = std::env::temp_dir().join("ts6_fast_cache");
    let hw_map = if include_hardware {
        load_hardware_map(&tpl_dir)
    } else {
        Vec::new()
    };
    let mut hw_resolved: Vec<(Option<String>, bool)> = Vec::new();
    if include_hardware && !model.hardware.is_empty() {
        for hw in &model.hardware {
            let (opt_path, has_proc) = resolve_hardware_component(hw, &hw_map, &hw_lib_dir);
            let staged = opt_path.map(|p| stage_to_local_cache(&p, &local_cache_dir));
            hw_resolved.push((staged, has_proc));
        }
    }

    let total_ops = model.total_cuts() + total_hole_ops;
    let hw_units = if include_hardware {
        model.hardware.len()
    } else {
        0
    };
    let total_units = variants.len()
        + model.panels.len()
        + total_ops
        + hw_units
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
        hardware_generated: 0,
        hardware_placed: 0,
        errors: 0,
        saved_path: None,
    };

    // Phase 0: Check and append missing Bazis materials & textures into TopSolid'Wood "Bazis" section
    if !model.materials.is_empty() {
        let _mat_rep = crate::materials::sync_materials_to_topsolid(&model.materials);
    }

    // Phase 1: Build missing cached exact-size native .top templates
    let t_p1 = Instant::now();
    if !variants.is_empty() {
        log_line(&format!("PHASE1 START: {} missing template variants", variants.len()));
        fs::create_dir_all(&cache_dir)
            .map_err(|e| format!("Failed to create cache dir {:?}: {}", cache_dir, e))?;
        for v in &variants {
            let t_v = Instant::now();
            if cancel.load(Ordering::Relaxed) {
                return Err("Stopped by user during template variant generation.".into());
            }
            let vname = Path::new(&v.dst).file_name().unwrap_or_default().to_string_lossy().to_string();
            on_progress(
                progress,
                total_units,
                &format!("Building cached template: {}", vname),
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
            if patched_ascii {
                let _ = cur_doc.call("Regenerate", &[]);
            }
            let _ = cur_doc.call("Save", &[])?;
            let _ = cur_doc.call("Close", &[ComArg::Bool(false), ComArg::Bool(false)]);
            log_line(&format!("  VARIANT {} built in {}ms (ascii={})", vname, t_v.elapsed().as_millis(), patched_ascii));
            stats.variants_built += 1;
            progress += 1;
        }
    }
    log_line(&format!("PHASE1 END in {:.2}s (built={})", t_p1.elapsed().as_secs_f64(), stats.variants_built));

    // Phase 2: Create new TopSolid design document, build all panels, and place operations
    let t_p2 = Instant::now();
    log_line(&format!("PHASE2 START: {} panels, {} cuts, {} hole_ops", model.panels.len(), model.total_cuts(), total_hole_ops));
    on_progress(progress, total_units, "Creating new TopSolid'Wood 6.25 document...");
    let doc = docs.call_obj("Add", &[ComArg::Str("top")])?;
    let shapes = doc.get_obj("Shapes")?;
    let curves = doc.get_obj("Curves")?;
    let csystems = doc.get_obj("CoordinateSystems")?;
    let components = doc.get_obj("Components")?;

    let mut apply_pairs: Vec<(String, String)> = Vec::new();
    let mut built_panels: Vec<(String, String, ComObj)> = Vec::new();
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
            Err(e) => {
                log_line(&format!("  PANEL {} ({}) ERR: {}", idx + 1, p.name, e));
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
        // Keep all panels on Layer 0 (TopSolid's default new document only displays Layer 0;
        // moving panels to Layers 1..4 hides them until the user manually enables those layers).
        let _ = blk.put("Layer", ComArg::I32(0));
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
        if p.edge_total_len_mm > 0.1 {
            let tl_s = format!("{:.1}mm", p.edge_total_len_mm);
            let _ = blk.call(
                "SetTextProperty",
                &[ComArg::Str("Bazis_Edge_TotalLen"), ComArg::Str(&tl_s)],
            );
        }
        for e in &p.edges {
            if matches!(e.side_tag.as_str(), "L1" | "L2" | "W1" | "W2") {
                let prop_name = format!("Bazis_Edge_{}", e.side_tag);
                let prop_val = format!("{} ({}mm, L={:.0}mm)", e.material, e.thickness_mm, e.length_mm);
                let _ = blk.call(
                    "SetTextProperty",
                    &[ComArg::Str(&prop_name), ComArg::Str(&prop_val)],
                );
            }
        }
        if !p.material.is_empty() {
            let _ = blk.call("SetMatter", &[ComArg::Str(&p.material)]);
            let _ = blk.call("SetCoating", &[ComArg::Str(&p.material)]);
        }

        // Edge banding strips (3D extruded strips for straight & arc edges + ClipPanel trim for shaped panels)
        if !p.edges.is_empty() {
            let mut edges_built = 0usize;
            for (ei, e) in p.edges.iter().enumerate() {
                let sloop = match &e.strip_loop {
                    Some(l) if !l.segs.is_empty() => l,
                    _ => continue,
                };
                // For shaped panels with ClipPanel=true, subtract the exact edge strip from the board first
                if !p.is_rect && e.clip_panel {
                    if let Ok(trim_curve) = build_loop_curve(&curves, sloop, &p.ax_x, &p.ax_y) {
                        if let Ok(trim_tool) = shapes.call_obj(
                            "AddBasicExtruded",
                            &[
                                ComArg::Obj(&trim_curve),
                                ComArg::F64(p.ax_z.x),
                                ComArg::F64(p.ax_z.y),
                                ComArg::F64(p.ax_z.z),
                                ComArg::F64(p.lz + 0.002),
                                ComArg::F64(0.001),
                                ComArg::F64(0.0),
                                ComArg::Bool(false),
                                ComArg::Bool(true),
                            ],
                        ) {
                            if let Ok(ops) = blk.get_obj("Operations") {
                                let _ = ops.call(
                                    "AddSubtraction",
                                    &[
                                        ComArg::Obj(&trim_tool),
                                        ComArg::NullDispatch,
                                        ComArg::Bool(true),
                                        ComArg::Bool(false),
                                    ],
                                );
                            }
                        }
                    }
                }
                // Build visible 3D edge band strip solid
                if let Ok(edge_curve) = build_loop_curve(&curves, sloop, &p.ax_x, &p.ax_y) {
                    if let Ok(edge_sh) = shapes.call_obj(
                        "AddBasicExtruded",
                        &[
                            ComArg::Obj(&edge_curve),
                            ComArg::F64(p.ax_z.x),
                            ComArg::F64(p.ax_z.y),
                            ComArg::F64(p.ax_z.z),
                            ComArg::F64(p.lz),
                            ComArg::F64(0.0),
                            ComArg::F64(0.0),
                            ComArg::Bool(false),
                            ComArg::Bool(true),
                        ],
                    ) {
                        let ename = format!("{}E{}", ts_panel_name, ei + 1);
                        let edes = format!(
                            "Edgeband [{}]: {} ({}x{}mm)",
                            e.side_tag, e.material, e.thickness_mm, e.width_mm
                        );
                        let _ = edge_sh.put("Name", ComArg::Str(&ename));
                        let _ = edge_sh.put("Designation", ComArg::Str(&edes));
                        if !e.code.is_empty() {
                            let _ = edge_sh.put("Reference", ComArg::Str(&e.code));
                        }
                        let _ = edge_sh.put("Layer", ComArg::I32(0));
                        let _ = edge_sh.call(
                            "SetTextProperty",
                            &[ComArg::Str("Bazis_Edge_Parent"), ComArg::Str(&ts_panel_name)],
                        );
                        let _ = edge_sh.call(
                            "SetTextProperty",
                            &[ComArg::Str("Bazis_Edge_Side"), ComArg::Str(&e.side_tag)],
                        );
                        let elen_s = format!("{:.1}mm", e.length_mm);
                        let _ = edge_sh.call(
                            "SetTextProperty",
                            &[ComArg::Str("Bazis_Edge_Length"), ComArg::Str(&elen_s)],
                        );
                        let ethk_s = format!("{}mm", e.thickness_mm);
                        let _ = edge_sh.call(
                            "SetTextProperty",
                            &[ComArg::Str("Bazis_Edge_Thickness"), ComArg::Str(&ethk_s)],
                        );
                        let _ = edge_sh.call(
                            "SetTextProperty",
                            &[
                                ComArg::Str("Bazis_Edge_ClipPanel"),
                                ComArg::Str(if e.clip_panel { "Yes" } else { "No" }),
                            ],
                        );
                        if !e.material.is_empty() {
                            let _ = edge_sh.call("SetMatter", &[ComArg::Str(&e.material)]);
                            let _ = edge_sh.call("SetCoating", &[ComArg::Str(&e.material)]);
                        }
                        edges_built += 1;
                    }
                }
            }
            if edges_built > 0 {
                log_line(&format!(
                    "  EDGES {} ({}): built={}/{} total_len={:.1}mm",
                    ts_panel_name,
                    p.name,
                    edges_built,
                    p.edges.len(),
                    p.edge_total_len_mm
                ));
            }
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
                let tpl_file_raw = cache_dir
                    .join(format!("B&S_{}_{}.top", c.op_kind, key))
                    .to_string_lossy()
                    .to_string();
                let tpl_file = stage_to_local_cache(&tpl_file_raw, &local_cache_dir);
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
                        log_line(&format!("  CUT SUBTRACT ERR on {}", ts_panel_name));
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
                        log_line(&format!("  CUT SUBTRACT ERR on {}", ts_panel_name));
                        stats.errors += 1;
                    }
                } else {
                    stats.errors += 1;
                }
            }
            progress += 1;
        }

        // Drilling holes (with automatic collinear row grouping via B&S_DrillRow.top)
        if mode == ExportMode::NativeTemplates && base_tpls.contains_key("drill") {
            for grp in &panel_hole_groups[idx] {
                if cancel.load(Ordering::Relaxed) {
                    return Err("Stopped by user during hole placement.".into());
                }
                let (tpl_file_raw, entry, ax_x, ax_y, hole_cnt) = match grp {
                    HoleGroup::Single(hi) => {
                        let h = &p.holes[*hi];
                        let key = format!("{}x{}", num_key(h.diam_mm), num_key(h.depth_mm));
                        let f = cache_dir
                            .join(format!("B&S_drill_{}.top", key))
                            .to_string_lossy()
                            .to_string();
                        (f, &h.entry, &h.tpl_ax_x, &h.tpl_ax_y, 1usize)
                    }
                    HoleGroup::Row {
                        entry,
                        ax_x,
                        ax_y,
                        diam_mm,
                        depth_mm,
                        count,
                        step_mm,
                    } => {
                        let key = format!(
                            "{}x{}x{}x{}",
                            num_key(*diam_mm),
                            num_key(*depth_mm),
                            count,
                            num_key(*step_mm)
                        );
                        let f = cache_dir
                            .join(format!("B&S_drillrow_{}.top", key))
                            .to_string_lossy()
                            .to_string();
                        (f, entry, ax_x, ax_y, *count)
                    }
                };
                let tpl_file = stage_to_local_cache(&tpl_file_raw, &local_cache_dir);
                op_seq += 1;
                let cmp_name = format!("Op{}", op_seq);
                let cs_res = csystems.call_obj(
                    "AddBasic",
                    &[
                        ComArg::F64(entry.x),
                        ComArg::F64(entry.y),
                        ComArg::F64(entry.z),
                        ComArg::F64(ax_x.x),
                        ComArg::F64(ax_x.y),
                        ComArg::F64(ax_x.z),
                        ComArg::F64(ax_y.x),
                        ComArg::F64(ax_y.y),
                        ComArg::F64(ax_y.z),
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
                        stats.holes += hole_cnt;
                    } else {
                        log_line(&format!("  HOLE ERR on {}: AddWithPositioning failed for {}", ts_panel_name, tpl_file));
                        stats.errors += 1;
                    }
                } else {
                    stats.errors += 1;
                }
                progress += 1;
            }
        } else if let Some(ref ops) = blk_ops {
            for h in &p.holes {
                if cancel.load(Ordering::Relaxed) {
                    return Err("Stopped by user during hole placement.".into());
                }
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
                        log_line(&format!("  HOLE EXTRUDE ERR on {}", ts_panel_name));
                        stats.errors += 1;
                    }
                } else {
                    stats.errors += 1;
                }
                progress += 1;
            }
        }

        built_panels.push((ts_panel_name, p.name.clone(), blk));
    }

    log_line(&format!(
        "PHASE2 END in {:.2}s: panels={}, cuts={}, holes={}, apply_pairs={}, errors={}",
        t_p2.elapsed().as_secs_f64(),
        stats.panels,
        stats.cuts,
        stats.holes,
        apply_pairs.len(),
        stats.errors
    ));

    // Phase 2c: Build native 3D bodies (Extrusions, Bodies of Revolution, Sweeps along Trajectory)
    if !model.bodies.is_empty() {
        log_line(&format!("PHASE2C START: {} 3D bodies (extrusion/revolve/sweep)", model.bodies.len()));
        for (b_idx, b) in model.bodies.iter().enumerate() {
            if cancel.load(Ordering::Relaxed) {
                return Err("Stopped by user during 3D body placement.".into());
            }
            let b_name = format!("B{}", b_idx + 1);
            match build_body_3d(&shapes, &curves, b, &b_name) {
                Ok(sh) => {
                    let faces = sh
                        .get_obj("Faces")
                        .and_then(|f| f.get("Count"))
                        .map(|v| v.as_i32())
                        .unwrap_or(-1);
                    let ops = sh
                        .get_obj("Operations")
                        .and_then(|o| o.get("Count"))
                        .map(|v| v.as_i32())
                        .unwrap_or(-1);
                    log_line(&format!(
                        "  VERIFY {} [{}] ({}): Faces={}, Ops={}",
                        b_name, b.kind, b.name, faces, ops
                    ));
                    stats.shaped += 1;
                }
                Err(e) => {
                    log_line(&format!("  BODY {} [{}] ({}) ERR: {}", b_name, b.kind, b.name, e));
                    stats.errors += 1;
                }
            }
        }
    }

    // Phase 3: Batch-apply Assembly -> Use process FIRST (on clean scene before hardware!)
    // so every panel immediately gets 100% native TopSolid'Wood operations.
    if mode == ExportMode::NativeTemplates && !apply_pairs.is_empty() {
        let base_prog = progress;
        stats.native_applied = apply_use_process_batch(&apply_pairs, cancel, |done, _tot, msg| {
            on_progress(base_prog + done, total_units, msg);
        })?;
        progress = base_prog + apply_pairs.len();
    }

    // Verify real TopSolid Faces.Count and Operations.Count on every built panel
    for (ts_name, des, blk) in &built_panels {
        let faces = blk
            .get_obj("Faces")
            .and_then(|f| f.get("Count"))
            .map(|v| v.as_i32())
            .unwrap_or(-1);
        let ops = blk
            .get_obj("Operations")
            .and_then(|o| o.get("Count"))
            .map(|v| v.as_i32())
            .unwrap_or(-1);
        log_line(&format!("  VERIFY {} ({}): Faces={}, Ops={}", ts_name, des, faces, ops));
    }

    // Phase 4: Fast hardware placement (after Use process!)
    // - Mapped vendor .top files (hardware_map.json) -> AddWithPositioningByCoordinateSystems (from local SSD cache)
    // - Generic hardware (dowels, screws, shelfholders, unmapped hinges) -> direct lightweight Parasolid solids (~2ms each!)
    let t_p4 = Instant::now();
    if include_hardware && !model.hardware.is_empty() {
        log_line(&format!("PHASE4 START: {} hardware items", model.hardware.len()));
        let mut hw_proc_pairs: Vec<(String, String)> = Vec::new();
        for (h_idx, hw) in model.hardware.iter().enumerate() {
            if cancel.load(Ordering::Relaxed) {
                return Err(format!(
                    "Stopped by user at hardware {}/{}.",
                    h_idx,
                    model.hardware.len()
                ));
            }
            let hw_name = format!("Hw{}", h_idx + 1);
            if h_idx == 0 || (h_idx + 1) % 25 == 0 || h_idx + 1 == model.hardware.len() {
                on_progress(
                    progress,
                    total_units,
                    &format!("Hardware {}/{}: {}", h_idx + 1, model.hardware.len(), hw.name),
                );
            }
            let (opt_path, has_proc) = &hw_resolved[h_idx];
            if let Some(comp_path) = opt_path {
                let cs_res = csystems.call_obj(
                    "AddBasic",
                    &[
                        ComArg::F64(hw.origin.x),
                        ComArg::F64(hw.origin.y),
                        ComArg::F64(hw.origin.z),
                        ComArg::F64(hw.ax_x.x),
                        ComArg::F64(hw.ax_x.y),
                        ComArg::F64(hw.ax_x.z),
                        ComArg::F64(hw.ax_y.x),
                        ComArg::F64(hw.ax_y.y),
                        ComArg::F64(hw.ax_y.z),
                    ],
                );
                if let Ok(cs) = cs_res {
                    if let Ok(cmp) = components.call_obj(
                        "AddWithPositioningByCoordinateSystems",
                        &[
                            ComArg::Str(comp_path),
                            ComArg::Str("Origin"),
                            ComArg::Obj(&cs),
                        ],
                    ) {
                        if let Ok(el) = cmp.get_obj("Element") {
                            let _ = el.put("Name", ComArg::Str(&hw_name));
                            let _ = el.put("Designation", ComArg::Str(&hw.name));
                            if !hw.article.is_empty() {
                                let _ = el.put("Reference", ComArg::Str(&hw.article));
                            }
                            if !hw.supplier.is_empty() {
                                let _ = el.put("Supplier", ComArg::Str(&hw.supplier));
                            }
                            let _ = el.put("Layer", ComArg::I32(0));
                        }
                        stats.hardware_placed += 1;
                        if *has_proc && mode == ExportMode::NativeTemplates {
                            for p_name in &hw.connected_panels {
                                hw_proc_pairs.push((hw_name.clone(), p_name.clone()));
                            }
                        }
                    } else {
                        log_line(&format!("  HW COMP ERR {}: AddWithPositioning failed for {}", hw_name, comp_path));
                        stats.errors += 1;
                    }
                } else {
                    stats.errors += 1;
                }
            } else {
                match place_fast_hardware_solid(&shapes, &curves, hw, &hw_name) {
                    Ok(()) => stats.hardware_placed += 1,
                    Err(e) => {
                        log_line(&format!("  HW {} ({}) ERR: {}", hw_name, hw.name, e));
                        stats.errors += 1;
                    }
                }
            }
            progress += 1;
        }
        if !hw_proc_pairs.is_empty() {
            let applied_hw = apply_use_process_batch(&hw_proc_pairs, cancel, |_d, _t, msg| {
                on_progress(progress, total_units, msg);
            })?;
            stats.native_applied += applied_hw;
        }
    }
    log_line(&format!(
        "PHASE4 END in {:.2}s: hardware_placed={}, errors={}",
        t_p4.elapsed().as_secs_f64(),
        stats.hardware_placed,
        stats.errors
    ));

    // Optional auto-save .top
    if auto_save && !model.save_top_path.is_empty() {
        let t_save = Instant::now();
        on_progress(
            total_units,
            total_units,
            &format!("Saving {}...", model.save_top_path),
        );
        let mut save_target = model.save_top_path.clone();
        if Path::new(&save_target).exists() && fs::remove_file(&save_target).is_err() {
            // File is currently open/locked in TopSolid; fall back to a unique suffixed filename
            let p = Path::new(&save_target);
            let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("Export");
            let parent = p.parent().unwrap_or_else(|| Path::new("."));
            for n in 2..=99 {
                let cand = parent.join(format!("{}_{}.top", stem, n));
                if !cand.exists() || fs::remove_file(&cand).is_ok() {
                    save_target = cand.to_string_lossy().to_string();
                    break;
                }
            }
        }
        if let Ok(doc_file) = doc.get_obj("Document") {
            match doc_file.call("SaveAs", &[ComArg::Str(&save_target)]) {
                Ok(_) => {
                    stats.saved_path = Some(save_target.clone());
                    log_line(&format!("SAVE OK in {:.2}s: {}", t_save.elapsed().as_secs_f64(), save_target));
                }
                Err(e) => {
                    log_line(&format!("SAVE ERR in {:.2}s: {}", t_save.elapsed().as_secs_f64(), e));
                }
            }
        }
    }

    log_line(&format!(
        "EXPORT COMPLETE in {:.2}s | panels={} cuts={} holes={} applied={} hw={} errors={}",
        t_total.elapsed().as_secs_f64(),
        stats.panels,
        stats.cuts,
        stats.holes,
        stats.native_applied,
        stats.hardware_placed,
        stats.errors
    ));
    on_progress(total_units, total_units, "Export complete.");
    Ok(stats)
}

/// Inspect the currently active TopSolid document via COM and return a per-shape summary
/// (Name, Designation, Faces.Count, Operations.Count, operation names).
pub fn inspect_active_document() -> Result<String, String> {
    let _com = ComGuard::init_sta()?;
    let app = ComObj::create("TopSolid.Application")?;
    let doc = app.get_obj("CurrentDocument")?;
    let doc_name = doc
        .get_obj("Document")
        .and_then(|d| d.get("Name"))
        .map(|v| v.as_string())
        .unwrap_or_default();
    let shapes = doc.get_obj("Shapes")?;
    let count = shapes.get("Count")?.as_i32();
    let mut out = format!("DOC: {} | SHAPES: {}\n", doc_name, count);
    for i in 1..=count {
        if let Ok(s) = shapes.get_item(i) {
            let nm = s.get("Name").map(|v| v.as_string()).unwrap_or_default();
            let des = s.get("Designation").map(|v| v.as_string()).unwrap_or_default();
            let faces = s
                .get_obj("Faces")
                .and_then(|f| f.get("Count"))
                .map(|v| v.as_i32())
                .unwrap_or(-1);
            let mut op_cnt = -1;
            let mut op_list: Vec<String> = Vec::new();
            if let Ok(ops) = s.get_obj("Operations") {
                op_cnt = ops.get("Count").map(|v| v.as_i32()).unwrap_or(-1);
                for j in 1..=op_cnt.max(0) {
                    if let Ok(op) = ops.get_item(j) {
                        let onm = op.get("Name").map(|v| v.as_string()).unwrap_or_default();
                        let odes = op.get("Designation").map(|v| v.as_string()).unwrap_or_default();
                        op_list.push(if odes.is_empty() { onm } else { format!("{}({})", onm, odes) });
                    }
                }
            }
            out.push_str(&format!(
                "  [{}] Name={} | Des={} | Faces={} | Ops={} [{}]\n",
                i,
                nm,
                des,
                faces,
                op_cnt,
                op_list.join(", ")
            ));
        }
    }
    Ok(out)
}
