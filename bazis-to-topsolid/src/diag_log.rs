#![cfg(windows)]

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Instant;

struct DiagLogger {
    files: Vec<File>,
    start: Instant,
}

static LOGGER: Mutex<Option<DiagLogger>> = Mutex::new(None);

fn candidate_log_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let shared = PathBuf::from(r"Y:\Works\bazis\Scripts\bazis_to_topsolid_last.log");
    if shared.parent().map(|p| p.exists()).unwrap_or(false) {
        paths.push(shared);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p = dir.join("bazis_to_topsolid_last.log");
            if !paths.iter().any(|x| x.to_string_lossy().eq_ignore_ascii_case(&p.to_string_lossy())) {
                paths.push(p);
            }
        }
    }
    if paths.is_empty() {
        paths.push(std::env::temp_dir().join("bazis_to_topsolid_last.log"));
    }
    paths
}

pub fn init_log(header: &str) {
    let mut files = Vec::new();
    for p in candidate_log_paths() {
        if let Ok(mut f) = OpenOptions::new().create(true).write(true).truncate(true).open(&p) {
            let _ = writeln!(f, "=== Bazis -> TopSolid'Wood 6.25 Diagnostic Log ===");
            let _ = writeln!(f, "{}", header);
            let _ = f.flush();
            files.push(f);
        }
    }
    if let Ok(mut guard) = LOGGER.lock() {
        *guard = Some(DiagLogger {
            files,
            start: Instant::now(),
        });
    }
}

pub fn log_line(msg: &str) {
    if let Ok(mut guard) = LOGGER.lock() {
        if let Some(ref mut lg) = *guard {
            let dt = lg.start.elapsed().as_secs_f64();
            for f in &mut lg.files {
                let _ = writeln!(f, "[+{:07.3}s] {}", dt, msg);
                let _ = f.flush();
            }
        }
    }
}
