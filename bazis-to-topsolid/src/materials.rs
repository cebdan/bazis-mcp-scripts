use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::diag_log;
use crate::model::MaterialDef;

#[derive(Debug, Default)]
pub struct MaterialSyncReport {
    pub added_materials: usize,
    pub updated_textures: usize,
    pub skipped_materials: usize,
    pub added_textures: usize,
    pub added_panels: usize,
    pub added_edges: usize,
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn hash_u32(s: &str) -> u32 {
    let mut h: u32 = 2166136261;
    for b in s.as_bytes() {
        h ^= *b as u32;
        h = h.wrapping_mul(16777619);
    }
    h
}

fn safe_ascii_id(s: &str) -> String {
    let mut out = String::new();
    for ch in s.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_uppercase());
        } else if !out.ends_with('_') {
            out.push('_');
        }
        if out.len() >= 28 {
            break;
        }
    }
    let trimmed = out.trim_matches('_');
    let base = if trimmed.is_empty() { "MAT" } else { trimmed };
    format!("{}_{:08X}", base, hash_u32(s))
}

fn safe_filename(s: &str) -> String {
    let mut out = String::new();
    for ch in s.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.' {
            out.push(ch);
        } else if ch == ' ' {
            out.push('_');
        }
    }
    let trimmed = out.trim_matches('_');
    if trimmed.is_empty() {
        format!("tex_{:08X}", hash_u32(s))
    } else {
        trimmed.to_string()
    }
}

fn find_missler_config_dir() -> PathBuf {
    for candidate in &[
        r"C:\Missler\Config",
        r"D:\Missler\Config",
    ] {
        let p = PathBuf::from(candidate);
        if p.exists() {
            return p;
        }
    }
    PathBuf::from(r"C:\Missler\Config")
}

/// Copy texture into `C:\Missler\Config\Textures\Bazis\` (converting jpg/png to bmp when possible
/// so TopSolid 6.25 renders it reliably without external codecs). Returns destination path.
fn stage_texture_file(src_path: &Path, tex_dir: &Path, mat_name: &str) -> Option<PathBuf> {
    if !src_path.exists() {
        return None;
    }
    let _ = fs::create_dir_all(tex_dir);
    let ext = src_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let stem = src_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(mat_name);
    let base = format!("{}_{:08X}", safe_filename(stem), hash_u32(src_path.to_string_lossy().as_ref()));

    if ext == "bmp" || ext == "ttx" {
        let dst = tex_dir.join(format!("{}.{}", base, ext));
        if !dst.exists() {
            let _ = fs::copy(src_path, &dst);
        }
        return if dst.exists() { Some(dst) } else { None };
    }

    // Prefer converting jpg/jpeg/png -> 24-bit BMP via PowerShell System.Drawing (built into Windows)
    let dst_bmp = tex_dir.join(format!("{}.bmp", base));
    if dst_bmp.exists() {
        return Some(dst_bmp);
    }

    let src_escaped = src_path.to_string_lossy().replace('\'', "''");
    let dst_escaped = dst_bmp.to_string_lossy().replace('\'', "''");
    let ps = format!(
        "Add-Type -AssemblyName System.Drawing; $img = [System.Drawing.Image]::FromFile('{}'); $bmp = New-Object System.Drawing.Bitmap($img.Width, $img.Height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.DrawImage($img, 0, 0, $img.Width, $img.Height); $g.Dispose(); $img.Dispose(); $bmp.Save('{}', [System.Drawing.Imaging.ImageFormat]::Bmp); $bmp.Dispose();",
        src_escaped, dst_escaped
    );
    let status = Command::new("powershell.exe")
        .args(["-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-Command", &ps])
        .status();
    if status.map(|s| s.success()).unwrap_or(false) && dst_bmp.exists() {
        return Some(dst_bmp);
    }

    // Fallback: copy original image directly
    let fallback_ext = if ext.is_empty() { "jpg" } else { &ext };
    let dst_orig = tex_dir.join(format!("{}.{}", base, fallback_ext));
    if !dst_orig.exists() {
        let _ = fs::copy(src_path, &dst_orig);
    }
    if dst_orig.exists() { Some(dst_orig) } else { None }
}

fn ensure_top_tex_skeleton(path: &Path) -> String {
    if let Ok(content) = fs::read_to_string(path) {
        if content.contains("<Textures") {
            return content;
        }
    }
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\r\n<Textures>\r\n  <Family name=\"Bazis\">\r\n  </Family>\r\n</Textures>\r\n".to_string()
}

fn ensure_topmaterials_skeleton(path: &Path) -> String {
    if let Ok(content) = fs::read_to_string(path) {
        if content.contains("<Materials") {
            if !content.contains("%BAZIS_ROOT") {
                let fam_block = concat!(
                    " <Family name=\"Bazis\">\r\n",
                    "  <IdKey>%BAZIS_ROOT</IdKey>\r\n",
                    "  <Family name=\"Panels\">\r\n",
                    "   <IdKey>%BAZIS_PANELS</IdKey>\r\n",
                    "  </Family>\r\n",
                    "  <Family name=\"Edgebanding\">\r\n",
                    "   <IdKey>%BAZIS_EDGES</IdKey>\r\n",
                    "  </Family>\r\n",
                    "  <Family name=\"Other\">\r\n",
                    "   <IdKey>%BAZIS_OTHER</IdKey>\r\n",
                    "  </Family>\r\n",
                    " </Family>\r\n",
                );
                if let Some(idx) = content.find("</Version>") {
                    let pos = idx + "</Version>".len();
                    let mut out = String::with_capacity(content.len() + fam_block.len() + 4);
                    out.push_str(&content[..pos]);
                    out.push_str("\r\n");
                    out.push_str(fam_block);
                    out.push_str(&content[pos..]);
                    return out;
                }
            }
            return content;
        }
    }
    concat!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\r\n",
        "<Materials>\r\n",
        " <Version>616204</Version>\r\n",
        " <Family name=\"Bazis\">\r\n",
        "  <IdKey>%BAZIS_ROOT</IdKey>\r\n",
        "  <Family name=\"Panels\">\r\n",
        "   <IdKey>%BAZIS_PANELS</IdKey>\r\n",
        "  </Family>\r\n",
        "  <Family name=\"Edgebanding\">\r\n",
        "   <IdKey>%BAZIS_EDGES</IdKey>\r\n",
        "  </Family>\r\n",
        "  <Family name=\"Other\">\r\n",
        "   <IdKey>%BAZIS_OTHER</IdKey>\r\n",
        "  </Family>\r\n",
        " </Family>\r\n",
        "</Materials>\r\n",
    )
    .to_string()
}

fn family_id_for(category: &str) -> &'static str {
    match category.to_ascii_lowercase().as_str() {
        "panel" | "panels" => "%BAZIS_PANELS",
        "edge" | "edgebanding" | "butt" => "%BAZIS_EDGES",
        _ => "%BAZIS_OTHER",
    }
}

fn default_density_for(m: &MaterialDef) -> f64 {
    if m.density > 0.01 {
        return m.density;
    }
    let low = m.name.to_ascii_lowercase();
    if low.contains("mdf") {
        0.78
    } else if low.contains("hdf") {
        0.85
    } else if low.contains("abs") || low.contains("pvc") || m.category == "edge" {
        1.05
    } else if low.contains("glass") || low.contains("mirror") {
        2.50
    } else if low.contains("steel") || low.contains("chrome") || low.contains("metal") {
        7.85
    } else if low.contains("alum") {
        2.70
    } else {
        0.72 // standard LDSP / chipboard
    }
}

fn format_material_xml(m: &MaterialDef, tex_key: &str) -> String {
    let name_xml = xml_escape(&m.name);
    let code_xml = if m.code.is_empty() {
        "NONE".to_string()
    } else {
        xml_escape(&m.code)
    };
    let fam_id = family_id_for(&m.category);
    let dens = default_density_for(m);
    let grain = if m.has_grain { 1 } else { 0 };
    let r = m.color_r.clamp(0.0, 1.0);
    let g = m.color_g.clamp(0.0, 1.0);
    let b = m.color_b.clamp(0.0, 1.0);
    let refl = m.reflection.clamp(0.0, 1.0);
    let trans = m.transparency.clamp(0.0, 1.0);
    let tex_xml = if tex_key.is_empty() {
        "NONE".to_string()
    } else {
        xml_escape(tex_key)
    };
    let pattern = if m.category == "panel" { 6 } else { 0 };

    format!(
        " <Material>\r\n\
         \x20 <Name>{name}</Name>\r\n\
         \x20 <Families>{fam}</Families>\r\n\
         \x20 <Matter>1</Matter>\r\n\
         \x20 <Coating>1</Coating>\r\n\
         \x20 <Finishing>0</Finishing>\r\n\
         \x20 <UserMat>1</UserMat>\r\n\
         \x20 <GrainOrientation>{grain}</GrainOrientation>\r\n\
         \x20 <Density>{dens:.3}</Density>\r\n\
         \x20 <DensityTol>0</DensityTol>\r\n\
         \x20 <YoungModulus>0</YoungModulus>\r\n\
         \x20 <PoissonRatio>0</PoissonRatio>\r\n\
         \x20 <Expansion>0</Expansion>\r\n\
         \x20 <ElasticLimit>0</ElasticLimit>\r\n\
         \x20 <ShearModulus>0</ShearModulus>\r\n\
         \x20 <ShrinkageFactor>1</ShrinkageFactor>\r\n\
         \x20 <ShrinkageFactorMin>1</ShrinkageFactorMin>\r\n\
         \x20 <ShrinkageFactorMax>1</ShrinkageFactorMax>\r\n\
         \x20 <InjectionPressureMin>1200</InjectionPressureMin>\r\n\
         \x20 <InjectionPressureMax>1200</InjectionPressureMax>\r\n\
         \x20 <Conductivity>0</Conductivity>\r\n\
         \x20 <ThermicInertia>0</ThermicInertia>\r\n\
         \x20 <Colour>{r:.4} {g:.4} {b:.4}</Colour>\r\n\
         \x20 <Specularity>0.1 1 1 1</Specularity>\r\n\
         \x20 <SpecularitySpreading>0.1</SpecularitySpreading>\r\n\
         \x20 <Ambient>1 1 1</Ambient>\r\n\
         \x20 <Translucency>{trans:.3}</Translucency>\r\n\
         \x20 <Texture>{tex}</Texture>\r\n\
         \x20 <Pattern>{pattern}</Pattern>\r\n\
         \x20 <PatternTopPath>NONE</PatternTopPath>\r\n\
         \x20 <PatternUserName>NONE</PatternUserName>\r\n\
         \x20 <Designation>{name}</Designation>\r\n\
         \x20 <Reference>{code}</Reference>\r\n\
         \x20 <Supplier>Bazis</Supplier>\r\n\
         \x20 <Reflection>{refl:.3}</Reflection>\r\n\
         \x20 <ReflectionAngle>0</ReflectionAngle>\r\n\
         \x20 <Refraction>1</Refraction>\r\n\
         \x20 <RefractionAngle>0</RefractionAngle>\r\n\
         \x20 <Anisotropy>0</Anisotropy>\r\n\
         \x20 <FresnelRef>0</FresnelRef>\r\n\
         \x20 <ReceiveShadow>1</ReceiveShadow>\r\n\
         \x20 <CastShadow>1</CastShadow>\r\n\
         \x20 <TextParam>4</TextParam>\r\n\
         \x20 <TexParamPosUScl>1</TexParamPosUScl>\r\n\
         \x20 <TexParamPosVScl>1</TexParamPosVScl>\r\n\
         \x20 <TextParamPosRot>0</TextParamPosRot>\r\n\
         \x20 <BumpTexture>NONE</BumpTexture>\r\n\
         \x20 <BumpTextParam>4</BumpTextParam>\r\n\
         \x20 <BumpTexParamPosUScl>0.05</BumpTexParamPosUScl>\r\n\
         \x20 <BumpTexParamPosVScl>0.05</BumpTexParamPosVScl>\r\n\
         \x20 <BumpTextParamPosRot>0</BumpTextParamPosRot>\r\n\
         \x20 <FinishingColour>1 1 1</FinishingColour>\r\n\
         \x20 <FinishingPercent>0</FinishingPercent>\r\n\
         \x20 <ModifDate>NONE</ModifDate>\r\n\
         \x20 <Other>0</Other>\r\n\
         \x20</Material>\r\n",
        name = name_xml,
        fam = fam_id,
        grain = grain,
        dens = dens,
        r = r,
        g = g,
        b = b,
        trans = trans,
        tex = tex_xml,
        pattern = pattern,
        code = code_xml,
        refl = refl
    )
}

/// Check and append Bazis materials, textures, panels, and edgebanding into
/// TopSolid'Wood 6.25 user catalogs under the dedicated `Bazis` section.
pub fn sync_materials_to_topsolid(materials: &[MaterialDef]) -> MaterialSyncReport {
    let mut rep = MaterialSyncReport::default();
    if materials.is_empty() {
        return rep;
    }

    let cfg_dir = find_missler_config_dir();
    let _ = fs::create_dir_all(&cfg_dir);
    let tex_dir = cfg_dir.join("Textures").join("Bazis");
    let top_mat_path = cfg_dir.join("topmaterials.xml");
    let top_tex_path = cfg_dir.join("top.tex");
    let top_pnl_path = cfg_dir.join("top.pnl");
    let top_edg_path = cfg_dir.join("top.edg");

    let mut mat_xml = ensure_topmaterials_skeleton(&top_mat_path);
    let mut tex_xml = ensure_top_tex_skeleton(&top_tex_path);
    let mut pnl_txt = fs::read_to_string(&top_pnl_path).unwrap_or_default();
    let mut edg_txt = fs::read_to_string(&top_edg_path).unwrap_or_default();

    let mut mat_dirty = !top_mat_path.exists();
    let mut tex_dirty = false;
    let mut pnl_dirty = false;
    let mut edg_dirty = false;

    let mut seen_names: HashSet<String> = HashSet::new();

    for m in materials {
        let name = m.name.trim();
        if name.is_empty() || !seen_names.insert(name.to_string()) {
            continue;
        }

        // 1. Stage texture & register in top.tex (under Family "Bazis") if present
        let mut tex_key = String::new();
        if !m.texture_path.trim().is_empty() {
            let src = PathBuf::from(m.texture_path.trim());
            if let Some(staged) = stage_texture_file(&src, &tex_dir, name) {
                let key = format!("%BAZIS_TEX_{}", safe_ascii_id(name));
                tex_key = key.clone();
                let key_tag = format!("<Key>{}</Key>", xml_escape(&key));
                if !tex_xml.contains(&key_tag) {
                    let display_name = if m.texture_name.trim().is_empty() {
                        name
                    } else {
                        m.texture_name.trim()
                    };
                    let entry = format!(
                        "    <Texture>\r\n\
                         \x20     <Key>{key}</Key>\r\n\
                         \x20     <Uri>{uri}</Uri>\r\n\
                         \x20     <Name>{dname}</Name>\r\n\
                         \x20     <Luminance>0</Luminance>\r\n\
                         \x20     <TexturingMode>4</TexturingMode>\r\n\
                         \x20     <CoordsU>1</CoordsU>\r\n\
                         \x20     <SpanU>0.600000</SpanU>\r\n\
                         \x20     <CoordsV>1</CoordsV>\r\n\
                         \x20     <SpanV>0.600000</SpanV>\r\n\
                         \x20     <Transparent>0</Transparent>\r\n\
                         \x20   </Texture>\r\n",
                        key = xml_escape(&key),
                        uri = xml_escape(&staged.to_string_lossy()),
                        dname = xml_escape(display_name)
                    );
                    if let Some(idx) = tex_xml.rfind("  </Family>") {
                        tex_xml.insert_str(idx, &entry);
                    } else if let Some(idx) = tex_xml.rfind("</Textures>") {
                        let wrapped = format!("  <Family name=\"Bazis\">\r\n{}  </Family>\r\n", entry);
                        tex_xml.insert_str(idx, &wrapped);
                    }
                    tex_dirty = true;
                    rep.added_textures += 1;
                }
            }
        }

        // 2. Check & append to topmaterials.xml (under Family "Bazis")
        let name_tag = format!("<Name>{}</Name>", xml_escape(name));
        if mat_xml.contains(&name_tag) {
            // If material exists without texture and we now have one, attach it!
            if !tex_key.is_empty() {
                if let Some(start) = mat_xml.find(&name_tag) {
                    if let Some(rel_end) = mat_xml[start..].find("</Material>") {
                        let block = &mat_xml[start..start + rel_end];
                        if block.contains("<Texture>NONE</Texture>") {
                            let new_block = block.replacen(
                                "<Texture>NONE</Texture>",
                                &format!("<Texture>{}</Texture>", xml_escape(&tex_key)),
                                1,
                            );
                            mat_xml.replace_range(start..start + rel_end, &new_block);
                            mat_dirty = true;
                            rep.updated_textures += 1;
                        }
                    }
                }
            }
            rep.skipped_materials += 1;
        } else {
            let entry = format_material_xml(m, &tex_key);
            if let Some(idx) = mat_xml.rfind("</Materials>") {
                mat_xml.insert_str(idx, &entry);
                mat_dirty = true;
                rep.added_materials += 1;
            }
        }

        // 3. Check & append sheet panels to top.pnl
        if m.category.eq_ignore_ascii_case("panel") && m.thickness_mm > 0.5 {
            let marker_des = format!("DESIGNATION\t{}", name);
            let marker_mat = format!("MATTER\t{}", name);
            if !pnl_txt.contains(&marker_des) && !pnl_txt.contains(&marker_mat) {
                let len_m = if m.length_mm > 100.0 { m.length_mm / 1000.0 } else { 2.800 };
                let wid_m = if m.width_mm > 100.0 { m.width_mm / 1000.0 } else { 2.070 };
                let thk_m = m.thickness_mm / 1000.0;
                let ref_str = if !m.code.is_empty() {
                    format!("Bazis_{}", m.code)
                } else {
                    format!("Bazis_{}mm_{:06X}", m.thickness_mm.round() as i32, hash_u32(name) & 0xFFFFFF)
                };
                if !pnl_txt.is_empty() && !pnl_txt.ends_with('\n') {
                    pnl_txt.push_str("\r\n");
                }
                if !pnl_txt.is_empty() && !pnl_txt.ends_with("\r\n\r\n") {
                    pnl_txt.push_str("\r\n");
                }
                pnl_txt.push_str(&format!(
                    "REFERENCE\t{ref_s}\r\n\
                     DESIGNATION\t{des}\r\n\
                     LENGTH\t{len:.12}\r\n\
                     WIDTH\t{wid:.12}\r\n\
                     THICKNESS\t{thk:.12}\r\n\
                     MATTER\t{des}\r\n\
                     COATING\t{des}\r\n\
                     PRICE\t0\r\n\
                     NEST_CALIBRATION\t0\r\n",
                    ref_s = ref_str,
                    des = name,
                    len = len_m,
                    wid = wid_m,
                    thk = thk_m
                ));
                pnl_dirty = true;
                rep.added_panels += 1;
            }
        }

        // 4. Check & append edgebanding to top.edg
        if m.category.eq_ignore_ascii_case("edge") && m.thickness_mm > 0.05 {
            let marker_des = format!("DESIGNATION\t{}", name);
            if !edg_txt.contains(&marker_des) {
                let wid_m = if m.width_mm > 1.0 { m.width_mm / 1000.0 } else { 0.019 };
                let thk_m = m.thickness_mm / 1000.0;
                let ref_str = if !m.code.is_empty() {
                    format!("Bazis_Edge_{}", m.code)
                } else {
                    format!("Bazis_Edge_{:06X}", hash_u32(name) & 0xFFFFFF)
                };
                if !edg_txt.is_empty() && !edg_txt.ends_with('\n') {
                    edg_txt.push_str("\r\n");
                }
                if !edg_txt.is_empty() && !edg_txt.ends_with("\r\n\r\n") {
                    edg_txt.push_str("\r\n");
                }
                edg_txt.push_str(&format!(
                    "REFERENCE\t{ref_s}\r\n\
                     DESIGNATION\t{des}\r\n\
                     WIDTH\t{wid:.12}\r\n\
                     THICKNESS\t{thk:.12}\r\n\
                     MATTER\t{des}\r\n\
                     COATING\t{des}\r\n\
                     PRICE\t0\r\n",
                    ref_s = ref_str,
                    des = name,
                    wid = wid_m,
                    thk = thk_m
                ));
                edg_dirty = true;
                rep.added_edges += 1;
            }
        }
    }

    if tex_dirty {
        if let Err(e) = fs::write(&top_tex_path, tex_xml.as_bytes()) {
            diag_log::log_line(&format!("MATERIALS WARN: failed to write top.tex: {}", e));
        }
    }
    if mat_dirty {
        if let Err(e) = fs::write(&top_mat_path, mat_xml.as_bytes()) {
            diag_log::log_line(&format!("MATERIALS WARN: failed to write topmaterials.xml: {}", e));
        }
    }
    if pnl_dirty {
        if let Err(e) = fs::write(&top_pnl_path, pnl_txt.as_bytes()) {
            diag_log::log_line(&format!("MATERIALS WARN: failed to write top.pnl: {}", e));
        }
    }
    if edg_dirty {
        if let Err(e) = fs::write(&top_edg_path, edg_txt.as_bytes()) {
            diag_log::log_line(&format!("MATERIALS WARN: failed to write top.edg: {}", e));
        }
    }

    diag_log::log_line(&format!(
        "PHASE0 MATERIALS SYNC (section=Bazis): added={} updated_tex={} existing={} textures={} panels_pnl={} edges_edg={}",
        rep.added_materials,
        rep.updated_textures,
        rep.skipped_materials,
        rep.added_textures,
        rep.added_panels,
        rep.added_edges
    ));
    rep
}
