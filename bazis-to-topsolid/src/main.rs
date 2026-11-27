#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod model;
#[cfg(windows)]
mod com;
#[cfg(windows)]
mod diag_log;
#[cfg(windows)]
mod exporter;
#[cfg(windows)]
mod win_ui;

use std::env;
use std::fs;
use std::path::PathBuf;

use model::BazisExportModel;

fn load_model(path: &str) -> Result<BazisExportModel, String> {
    let raw = fs::read_to_string(path).map_err(|e| format!("Cannot read '{}': {}", path, e))?;
    serde_json::from_str(&raw).map_err(|e| format!("Invalid JSON in '{}': {}", path, e))
}

#[cfg(not(windows))]
fn main() {
    eprintln!("bazis-to-topsolid is a Windows application (compile with --target x86_64-pc-windows-gnu).");
    if let Some(arg) = env::args().nth(1) {
        match load_model(&arg) {
            Ok(m) => println!(
                "Parsed '{}': {} panels, {} cuts, {} holes",
                m.model_name,
                m.panels.len(),
                m.total_cuts(),
                m.total_holes()
            ),
            Err(e) => eprintln!("Error: {}", e),
        }
    }
}

#[cfg(windows)]
fn main() {
    win_ui::init_dpi_aware();
    let args: Vec<String> = env::args().collect();
    if args.iter().any(|a| a == "--inspect") {
        match exporter::inspect_active_document() {
            Ok(report) => {
                println!("{}", report);
                let _ = fs::write(r"Y:\Works\bazis\Scripts\verify_ts6_doc.txt", &report);
                let _ = fs::write(r"C:\Users\danch\Documents\Bazis\Scripts\verify_ts6_doc.txt", &report);
            }
            Err(e) => {
                eprintln!("ERR|{}", e);
                std::process::exit(1);
            }
        }
        return;
    }
    if args.iter().any(|a| a == "--cli") {
        let json_path = args
            .iter()
            .skip(1)
            .find(|a| !a.starts_with("--"))
            .cloned()
            .unwrap_or_default();
        let mode = if args.iter().any(|a| a == "--fast") {
            exporter::ExportMode::FastParasolid
        } else {
            exporter::ExportMode::NativeTemplates
        };
        let auto_save = args.iter().any(|a| a == "--save");
        let include_hardware = !args.iter().any(|a| a == "--no-hardware");
        match load_model(&json_path) {
            Ok(mut m) => {
                if let Some(pos) = args.iter().position(|a| a == "--out") {
                    if let Some(p) = args.get(pos + 1) {
                        m.save_top_path = p.clone();
                    }
                }
                let cancel = std::sync::atomic::AtomicBool::new(false);
                match exporter::run_export(
                    &m,
                    mode,
                    auto_save || !m.save_top_path.is_empty(),
                    include_hardware,
                    &cancel,
                    |d, t, msg| {
                        println!("[{}/{}] {}", d, t, msg);
                    },
                ) {
                    Ok(st) => println!(
                        "OK|panels={}|cuts={}|holes={}|variants={}|applied={}|hw_gen={}|hw_placed={}|errors={}|saved={}",
                        st.panels,
                        st.cuts,
                        st.holes,
                        st.variants_built,
                        st.native_applied,
                        st.hardware_generated,
                        st.hardware_placed,
                        st.errors,
                        st.saved_path.unwrap_or_default()
                    ),
                    Err(e) => {
                        eprintln!("ERR|{}", e);
                        std::process::exit(1);
                    }
                }
            }
            Err(e) => {
                eprintln!("ERR|{}", e);
                std::process::exit(1);
            }
        }
        return;
    }

    let initial_json = args.get(1).cloned().map(PathBuf::from);
    win_gui::run(initial_json);
}

#[cfg(windows)]
mod win_gui {
    use std::path::PathBuf;
    use std::ptr::{null, null_mut};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::Instant;

    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
    use windows_sys::Win32::Graphics::Gdi::{
        GetDC, GetDeviceCaps, GetStockObject, ReleaseDC, COLOR_BTNFACE, DEFAULT_GUI_FONT,
        LOGPIXELSX,
    };
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::Controls::{
        InitCommonControlsEx, INITCOMMONCONTROLSEX, EM_REPLACESEL, EM_SETSEL, ICC_PROGRESS_CLASS,
        PBM_SETPOS, PBM_SETRANGE32, PROGRESS_CLASSW,
    };
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::EnableWindow;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, GetWindowRect, KillTimer,
        MessageBoxW, PostMessageW, PostQuitMessage, RegisterClassW, SendMessageW, SetTimer,
        SetWindowPos, SetWindowTextW, ShowWindow, SystemParametersInfoW, TranslateMessage,
        BM_GETCHECK, BM_SETCHECK, BS_AUTOCHECKBOX, BS_AUTORADIOBUTTON, BS_DEFPUSHBUTTON,
        BS_PUSHBUTTON, CW_USEDEFAULT, ES_AUTOVSCROLL, ES_MULTILINE, ES_READONLY, HWND_NOTOPMOST,
        HWND_TOPMOST, IDOK, MB_ICONWARNING, MB_OKCANCEL, MB_SETFOREGROUND, MSG, SPI_GETWORKAREA,
        SWP_NOMOVE, SWP_NOSIZE, SW_RESTORE, SW_SHOW, WM_APP, WM_COMMAND, WM_DESTROY, WM_SETFONT,
        WM_TIMER, WNDCLASSW, WS_BORDER, WS_CAPTION, WS_CHILD, WS_GROUP, WS_MINIMIZEBOX,
        WS_OVERLAPPED, WS_SYSMENU, WS_VISIBLE, WS_VSCROLL,
    };

    use crate::com::to_wide_null;
    use crate::exporter::{self, ExportMode};
    use crate::load_model;
    use crate::model::BazisExportModel;
    use crate::win_ui;

    const ID_RADIO_NATIVE: usize = 101;
    const ID_RADIO_FAST: usize = 102;
    const ID_CHK_AUTOSAVE: usize = 103;
    const ID_BTN_START: usize = 104;
    const ID_BTN_STOP: usize = 105;
    const ID_CHK_LOCK_INPUT: usize = 106;
    const ID_CHK_HARDWARE: usize = 107;
    const ID_TIMER_METRICS: usize = 1;

    const WM_APP_PROGRESS: u32 = WM_APP + 1;
    const WM_APP_DONE: u32 = WM_APP + 2;
    const WM_APP_LOCK_TOPSOLID: u32 = WM_APP + 3;

    struct AppState {
        hwnd_main: HWND,
        hwnd_radio_native: HWND,
        hwnd_chk_save: HWND,
        hwnd_chk_lock: HWND,
        hwnd_chk_hw: HWND,
        hwnd_progress: HWND,
        hwnd_metrics: HWND,
        hwnd_status: HWND,
        hwnd_log: HWND,
        hwnd_start: HWND,
        hwnd_stop: HWND,
        model: Option<BazisExportModel>,
        running: bool,
        input_locked: bool,
        start_time: Option<Instant>,
        total_panels: usize,
        panels_done: Arc<AtomicUsize>,
        ops_done: Arc<AtomicUsize>,
        cancel: Arc<AtomicBool>,
        pending_logs: Arc<Mutex<Vec<String>>>,
        last_status: Arc<Mutex<String>>,
        prog_cur: Arc<Mutex<(usize, usize)>>,
    }

    static STATE: Mutex<Option<AppState>> = Mutex::new(None);
    unsafe impl Send for AppState {}

    fn format_duration(secs: u64) -> String {
        let h = secs / 3600;
        let m = (secs % 3600) / 60;
        let s = secs % 60;
        if h > 0 {
            format!("{:02}:{:02}:{:02}", h, m, s)
        } else {
            format!("{:02}:{:02}", m, s)
        }
    }

    fn format_metrics_line(st: &AppState) -> String {
        let Some(t0) = st.start_time else {
            return "Elapsed: 00:00  |  Speed: -- parts/min, -- ops/min  |  ETA: --:--".into();
        };
        let elapsed_s = t0.elapsed().as_secs_f64();
        let mins = (elapsed_s / 60.0).max(1.0 / 60.0);
        let p_done = st.panels_done.load(Ordering::Relaxed);
        let o_done = st.ops_done.load(Ordering::Relaxed);
        let (cur, tot) = *st.prog_cur.lock().unwrap();

        let parts_per_min = if elapsed_s >= 1.0 { p_done as f64 / mins } else { 0.0 };
        let ops_per_min = if elapsed_s >= 1.0 { o_done as f64 / mins } else { 0.0 };

        let eta_str = if !st.running {
            "Done".to_string()
        } else if cur > 2 && tot > cur && elapsed_s >= 2.0 {
            let rem_s = (elapsed_s / cur as f64) * (tot - cur) as f64;
            format!("~{}", format_duration(rem_s.round() as u64))
        } else {
            "--:--".to_string()
        };

        let lock_badge = if st.input_locked { "  |  [TopSolid LOCKED]" } else { "" };
        format!(
            "Elapsed: {}  |  Parts: {}/{} ({:.1}/min)  |  Ops: {} ({:.1}/min)  |  ETA: {}{}",
            format_duration(elapsed_s as u64),
            p_done,
            st.total_panels,
            parts_per_min,
            o_done,
            ops_per_min,
            eta_str,
            lock_badge
        )
    }

    fn set_text(hwnd: HWND, text: &str) {
        let w = to_wide_null(text);
        unsafe { SetWindowTextW(hwnd, w.as_ptr()) };
    }

    fn append_log(hwnd_log: HWND, line: &str) {
        let mut msg = String::from(line);
        msg.push_str("\r\n");
        let w = to_wide_null(&msg);
        unsafe {
            SendMessageW(hwnd_log, EM_SETSEL, usize::MAX, -1);
            SendMessageW(hwnd_log, EM_REPLACESEL, 0, w.as_ptr() as isize);
        }
    }

    fn parse_panel_index(msg: &str) -> Option<usize> {
        let rest = msg.strip_prefix("Panel ")?;
        let slash = rest.find('/')?;
        rest[..slash].trim().parse::<usize>().ok()
    }

    fn confirm_pre_export_dialog(owner: HWND) -> bool {
        let title = to_wide_null("Prepare TopSolid'Wood 6.25 for Export");
        let body = to_wide_null(
            "Before starting the export:\r\n\r\n\
             1. Save and close all open projects in TopSolid'Wood 6.25.\r\n\
             2. Close TopSolid'Wood 6.25 (or click OK to close/restart it automatically).\r\n\r\n\
             After you click OK:\r\n\
             - The TopSolid MCP bridge will be restarted.\r\n\
             - A clean TopSolid'Wood 6.25 instance will be launched.\r\n\r\n\
             WARNING: While the export is running, TopSolid'Wood 6.25 will be LOCKED.\r\n\
             Working in TopSolid will be impossible until export finishes (or you click Stop).\r\n\r\n\
             Continue?",
        );
        let rc = unsafe {
            MessageBoxW(
                owner,
                body.as_ptr(),
                title.as_ptr(),
                MB_OKCANCEL | MB_ICONWARNING | MB_SETFOREGROUND,
            )
        };
        rc == IDOK
    }

    fn start_export_worker() {
        let pre_hwnd = {
            let guard = STATE.lock().unwrap();
            let Some(st) = guard.as_ref() else { return };
            if st.running {
                return;
            }
            if st.model.is_none() {
                append_log(st.hwnd_log, "No model JSON loaded. Run export_topsolid6.js from Bazis 2022.");
                return;
            }
            st.hwnd_main
        };

        // Ask user to save & close open projects and warn that TopSolid will be restarted & locked
        if !confirm_pre_export_dialog(pre_hwnd) {
            return;
        }

        let (hwnd_main, model, mode, auto_save, want_lock, include_hw, cancel, pending_logs, last_status, prog_cur, panels_done, ops_done) = {
            let mut guard = STATE.lock().unwrap();
            let st = match guard.as_mut() {
                Some(s) => s,
                None => return,
            };
            if st.running {
                return;
            }
            let model = match st.model.clone() {
                Some(m) => m,
                None => return,
            };
            let is_native = unsafe { SendMessageW(st.hwnd_radio_native, BM_GETCHECK, 0, 0) } == 1;
            let auto_save = unsafe { SendMessageW(st.hwnd_chk_save, BM_GETCHECK, 0, 0) } == 1;
            let want_lock = unsafe { SendMessageW(st.hwnd_chk_lock, BM_GETCHECK, 0, 0) } == 1;
            let include_hw = unsafe { SendMessageW(st.hwnd_chk_hw, BM_GETCHECK, 0, 0) } == 1;
            st.running = true;
            st.input_locked = false;
            st.start_time = Some(Instant::now());
            st.total_panels = model.panels.len();
            st.panels_done.store(0, Ordering::Relaxed);
            st.ops_done.store(0, Ordering::Relaxed);
            *st.prog_cur.lock().unwrap() = (0, 100);
            st.cancel.store(false, Ordering::Relaxed);

            unsafe {
                EnableWindow(st.hwnd_start, 0);
                EnableWindow(st.hwnd_stop, 1);
                // Un-maximize and dock exporter window in bottom-right corner so it NEVER covers
                // TopSolid's top menu bar (Assembly -> Use process) or prompt bar!
                ShowWindow(st.hwnd_main, SW_RESTORE);
                let mut wa: RECT = std::mem::zeroed();
                let mut wr: RECT = std::mem::zeroed();
                if SystemParametersInfoW(SPI_GETWORKAREA, 0, &mut wa as *mut RECT as *mut _, 0) != 0
                    && GetWindowRect(st.hwnd_main, &mut wr) != 0
                {
                    let w = (wr.right - wr.left).max(400);
                    let h = (wr.bottom - wr.top).max(300);
                    let x = (wa.right - w - 12).max(wa.left);
                    let y = (wa.bottom - h - 12).max(wa.top);
                    SetWindowPos(st.hwnd_main, HWND_TOPMOST, x, y, w, h, 0);
                } else {
                    SetWindowPos(st.hwnd_main, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
                }
                SetTimer(st.hwnd_main, ID_TIMER_METRICS, 500, None);
            }
            set_text(st.hwnd_metrics, &format_metrics_line(st));
            append_log(
                st.hwnd_log,
                &format!(
                    "Preparing clean TopSolid + MCP restart for {} export ('{}')...",
                    if is_native { "NATIVE TopSolid'Wood" } else { "Fast Parasolid" },
                    model.model_name
                ),
            );
            (
                st.hwnd_main,
                model,
                if is_native {
                    ExportMode::NativeTemplates
                } else {
                    ExportMode::FastParasolid
                },
                auto_save,
                want_lock,
                include_hw,
                st.cancel.clone(),
                st.pending_logs.clone(),
                st.last_status.clone(),
                st.prog_cur.clone(),
                st.panels_done.clone(),
                st.ops_done.clone(),
            )
        };

        let hwnd_addr = hwnd_main as usize;
        let t_start = Instant::now();
        thread::spawn(move || {
            let hwnd = hwnd_addr as HWND;

            // Step 0: Cleanly close/restart TopSolid 6.25 and TopSolid MCP bridge
            let prep_res = win_ui::restart_topsolid_and_mcp(&cancel, |msg| {
                *last_status.lock().unwrap() = msg.to_string();
                pending_logs.lock().unwrap().push(msg.to_string());
                unsafe { PostMessageW(hwnd, WM_APP_PROGRESS, 0, 0) };
            });

            if let Err(e) = prep_res {
                let elapsed_s = t_start.elapsed().as_secs_f64();
                let msg = format!("STOPPED/ERROR after {}: {}", format_duration(elapsed_s as u64), e);
                *last_status.lock().unwrap() = msg.clone();
                pending_logs.lock().unwrap().push(msg);
                unsafe { PostMessageW(hwnd, WM_APP_DONE, 0, 0) };
                return;
            }

            // Lock the newly launched TopSolid process input on the GUI thread before starting export
            if want_lock {
                unsafe { PostMessageW(hwnd, WM_APP_LOCK_TOPSOLID, 0, 0) };
            }

            let res = exporter::run_export(&model, mode, auto_save, include_hw, &cancel, |cur, tot, msg| {
                *prog_cur.lock().unwrap() = (cur, tot);
                if let Some(pidx) = parse_panel_index(msg) {
                    panels_done.store(pidx, Ordering::Relaxed);
                } else if msg.starts_with("Use process:") {
                    ops_done.fetch_add(1, Ordering::Relaxed);
                }
                *last_status.lock().unwrap() = msg.to_string();
                if cur == 0 || cur == tot || cur % 10 == 0 || !msg.starts_with("Use process:") {
                    pending_logs.lock().unwrap().push(format!("[{}/{}] {}", cur, tot, msg));
                }
                unsafe { PostMessageW(hwnd, WM_APP_PROGRESS, 0, 0) };
            });

            let elapsed_s = t_start.elapsed().as_secs_f64();
            let mins = (elapsed_s / 60.0).max(1.0 / 60.0);
            match res {
                Ok(st) => {
                    panels_done.store(st.panels, Ordering::Relaxed);
                    let total_ops_done = if st.native_applied > 0 {
                        st.native_applied
                    } else {
                        st.cuts + st.holes
                    };
                    ops_done.store(total_ops_done, Ordering::Relaxed);
                    let summary = format!(
                        "DONE in {}! Panels={} ({:.1}/min), Ops={} ({:.1}/min), Hardware={} (new lib: {}), Errors={}{}",
                        format_duration(elapsed_s as u64),
                        st.panels,
                        st.panels as f64 / mins,
                        total_ops_done,
                        total_ops_done as f64 / mins,
                        st.hardware_placed,
                        st.hardware_generated,
                        st.errors,
                        st.saved_path
                            .as_ref()
                            .map(|p| format!(", Saved={}", p))
                            .unwrap_or_default()
                    );
                    *last_status.lock().unwrap() = summary.clone();
                    pending_logs.lock().unwrap().push(summary);
                }
                Err(e) => {
                    let msg = format!("STOPPED/ERROR after {}: {}", format_duration(elapsed_s as u64), e);
                    *last_status.lock().unwrap() = msg.clone();
                    pending_logs.lock().unwrap().push(msg);
                }
            }
            unsafe { PostMessageW(hwnd, WM_APP_DONE, 0, 0) };
        });
    }

    unsafe extern "system" fn wnd_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match msg {
            WM_COMMAND => {
                let id = wparam & 0xFFFF;
                if id == ID_BTN_START {
                    start_export_worker();
                } else if id == ID_BTN_STOP {
                    win_ui::uninstall_topsolid_input_lock();
                    if let Some(st) = STATE.lock().unwrap().as_mut() {
                        st.input_locked = false;
                        st.cancel.store(true, Ordering::Relaxed);
                        set_text(st.hwnd_status, "Stopping... (TopSolid input unlocked)");
                        set_text(st.hwnd_metrics, &format_metrics_line(st));
                    }
                }
                0
            }
            WM_TIMER => {
                if wparam == ID_TIMER_METRICS {
                    if let Some(st) = STATE.lock().unwrap().as_ref() {
                        set_text(st.hwnd_metrics, &format_metrics_line(st));
                    }
                }
                0
            }
            WM_APP_LOCK_TOPSOLID => {
                if let Some(st) = STATE.lock().unwrap().as_mut() {
                    if st.running && !st.cancel.load(Ordering::Relaxed) {
                        st.input_locked = win_ui::install_topsolid_input_lock();
                        if st.input_locked {
                            append_log(st.hwnd_log, "TopSolid mouse/keyboard input LOCKED (click Stop to cancel & unlock).");
                            set_text(st.hwnd_metrics, &format_metrics_line(st));
                        }
                    }
                }
                0
            }
            WM_APP_PROGRESS => {
                if let Some(st) = STATE.lock().unwrap().as_ref() {
                    let (cur, tot) = *st.prog_cur.lock().unwrap();
                    SendMessageW(st.hwnd_progress, PBM_SETRANGE32, 0, tot.max(1) as isize);
                    SendMessageW(st.hwnd_progress, PBM_SETPOS, cur, 0);
                    set_text(st.hwnd_metrics, &format_metrics_line(st));
                    let status = st.last_status.lock().unwrap().clone();
                    set_text(st.hwnd_status, &status);
                    let mut logs = st.pending_logs.lock().unwrap();
                    for line in logs.drain(..) {
                        append_log(st.hwnd_log, &line);
                    }
                }
                0
            }
            WM_APP_DONE => {
                win_ui::uninstall_topsolid_input_lock();
                KillTimer(hwnd, ID_TIMER_METRICS);
                SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
                if let Some(st) = STATE.lock().unwrap().as_mut() {
                    st.running = false;
                    st.input_locked = false;
                    EnableWindow(st.hwnd_start, 1);
                    EnableWindow(st.hwnd_stop, 0);
                    set_text(st.hwnd_metrics, &format_metrics_line(st));
                    let status = st.last_status.lock().unwrap().clone();
                    set_text(st.hwnd_status, &status);
                    let mut logs = st.pending_logs.lock().unwrap();
                    for line in logs.drain(..) {
                        append_log(st.hwnd_log, &line);
                    }
                }
                0
            }
            WM_DESTROY => {
                win_ui::uninstall_topsolid_input_lock();
                KillTimer(hwnd, ID_TIMER_METRICS);
                if let Some(st) = STATE.lock().unwrap().as_ref() {
                    st.cancel.store(true, Ordering::Relaxed);
                }
                PostQuitMessage(0);
                0
            }
            _ => DefWindowProcW(hwnd, msg, wparam, lparam),
        }
    }

    pub fn run(initial_json: Option<PathBuf>) {
        unsafe {
            let icc = INITCOMMONCONTROLSEX {
                dwSize: std::mem::size_of::<INITCOMMONCONTROLSEX>() as u32,
                dwICC: ICC_PROGRESS_CLASS,
            };
            InitCommonControlsEx(&icc);

            let hinst = GetModuleHandleW(null());
            let cls_name = to_wide_null("BazisToTopSolid6Class");
            let wc = WNDCLASSW {
                style: 0,
                lpfnWndProc: Some(wnd_proc),
                cbClsExtra: 0,
                cbWndExtra: 0,
                hInstance: hinst,
                hIcon: null_mut(),
                hCursor: null_mut(),
                hbrBackground: (COLOR_BTNFACE + 1) as _,
                lpszMenuName: null(),
                lpszClassName: cls_name.as_ptr(),
            };
            RegisterClassW(&wc);

            let hdc = GetDC(null_mut());
            let dpi = if !hdc.is_null() {
                let d = GetDeviceCaps(hdc, LOGPIXELSX as i32);
                ReleaseDC(null_mut(), hdc);
                d.max(96)
            } else {
                96
            };
            let sc = |v: i32| -> i32 { (v * dpi + 48) / 96 };

            let title = to_wide_null("Bazis -> TopSolid'Wood 6.25 Exporter (Rust)");
            let hwnd = CreateWindowExW(
                0,
                cls_name.as_ptr(),
                title.as_ptr(),
                WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX | WS_VISIBLE,
                CW_USEDEFAULT,
                CW_USEDEFAULT,
                sc(660),
                sc(548),
                null_mut(),
                null_mut(),
                hinst,
                null(),
            );

            let font = GetStockObject(DEFAULT_GUI_FONT) as usize;
            let static_cls = to_wide_null("STATIC");
            let btn_cls = to_wide_null("BUTTON");
            let edit_cls = to_wide_null("EDIT");

            let mk = |cls: &[u16], text: &str, style: u32, x: i32, y: i32, w: i32, h: i32, id: usize| -> HWND {
                let wt = to_wide_null(text);
                let c = CreateWindowExW(0, cls.as_ptr(), wt.as_ptr(), WS_CHILD | WS_VISIBLE | style, sc(x), sc(y), sc(w), sc(h), hwnd, id as _, hinst, null());
                SendMessageW(c, WM_SETFONT, font, 1);
                c
            };

            let (loaded_model, info_text) = match initial_json {
                Some(ref p) => match load_model(&p.to_string_lossy()) {
                    Ok(m) => {
                        let s = format!(
                            "Model: {}   |   Panels: {}   |   Cuts: {}   |   Holes: {}   |   Hardware: {}",
                            m.model_name,
                            m.panels.len(),
                            m.total_cuts(),
                            m.total_holes(),
                            m.hardware.len()
                        );
                        (Some(m), s)
                    }
                    Err(e) => (None, format!("Error loading JSON: {}", e)),
                },
                None => (
                    None,
                    "No model JSON provided. Run Scripts -> export_topsolid6.js in Bazis 2022.".into(),
                ),
            };

            let _hwnd_info = mk(&static_cls, &info_text, 0, 16, 14, 592, 24, 0);
            let hwnd_radio_native = mk(
                &btn_cls,
                "Native TopSolid'Wood Operations (B&&S_*.top + Use process, ZERO AddSubtraction)",
                BS_AUTORADIOBUTTON as u32 | WS_GROUP,
                16,
                44,
                592,
                22,
                ID_RADIO_NATIVE,
            );
            let _hwnd_radio_fast = mk(
                &btn_cls,
                "Fast Parasolid Solids (AddSubtraction, no UI clicks)",
                BS_AUTORADIOBUTTON as u32,
                16,
                70,
                592,
                22,
                ID_RADIO_FAST,
            );
            SendMessageW(hwnd_radio_native, BM_SETCHECK, 1, 0);

            let hwnd_chk_save = mk(
                &btn_cls,
                "Auto-save .top file on completion",
                BS_AUTOCHECKBOX as u32,
                16,
                96,
                340,
                22,
                ID_CHK_AUTOSAVE,
            );
            SendMessageW(hwnd_chk_save, BM_SETCHECK, 1, 0);

            let hwnd_chk_lock = mk(
                &btn_cls,
                "Lock TopSolid mouse/keyboard during export (Stop stays active)",
                BS_AUTOCHECKBOX as u32,
                16,
                122,
                380,
                22,
                ID_CHK_LOCK_INPUT,
            );
            SendMessageW(hwnd_chk_lock, BM_SETCHECK, 1, 0);

            let hwnd_chk_hw = mk(
                &btn_cls,
                "Export hardware as components (auto-library: TopSolid_Lib_Bazis)",
                BS_AUTOCHECKBOX as u32,
                16,
                148,
                380,
                22,
                ID_CHK_HARDWARE,
            );
            SendMessageW(hwnd_chk_hw, BM_SETCHECK, 1, 0);

            let hwnd_start = mk(&btn_cls, "Start Export", BS_DEFPUSHBUTTON as u32, 410, 114, 114, 34, ID_BTN_START);
            let hwnd_stop = mk(&btn_cls, "Stop", BS_PUSHBUTTON as u32, 534, 114, 94, 34, ID_BTN_STOP);
            EnableWindow(hwnd_stop, 0);

            let hwnd_progress = CreateWindowExW(
                0,
                PROGRESS_CLASSW,
                null(),
                WS_CHILD | WS_VISIBLE,
                sc(16),
                sc(180),
                sc(612),
                sc(22),
                hwnd,
                null_mut(),
                hinst,
                null(),
            );
            let hwnd_metrics = mk(
                &static_cls,
                "Elapsed: 00:00  |  Speed: -- parts/min, -- ops/min  |  ETA: --:--",
                0,
                16,
                210,
                612,
                20,
                0,
            );
            let hwnd_status = mk(&static_cls, "Ready. Keep TopSolid'Wood 6.25 open.", 0, 16, 234, 612, 20, 0);
            let hwnd_log = mk(
                &edit_cls,
                "",
                WS_BORDER | WS_VSCROLL | ES_MULTILINE as u32 | ES_READONLY as u32 | ES_AUTOVSCROLL as u32,
                16,
                260,
                612,
                232,
                0,
            );

            let has_model = loaded_model.is_some();
            let total_panels = loaded_model.as_ref().map(|m| m.panels.len()).unwrap_or(0);
            *STATE.lock().unwrap() = Some(AppState {
                hwnd_main: hwnd,
                hwnd_radio_native,
                hwnd_chk_save,
                hwnd_chk_lock,
                hwnd_chk_hw,
                hwnd_progress,
                hwnd_metrics,
                hwnd_status,
                hwnd_log,
                hwnd_start,
                hwnd_stop,
                model: loaded_model,
                running: false,
                input_locked: false,
                start_time: None,
                total_panels,
                panels_done: Arc::new(AtomicUsize::new(0)),
                ops_done: Arc::new(AtomicUsize::new(0)),
                cancel: Arc::new(AtomicBool::new(false)),
                pending_logs: Arc::new(Mutex::new(Vec::new())),
                last_status: Arc::new(Mutex::new(String::new())),
                prog_cur: Arc::new(Mutex::new((0, 100))),
            });

            ShowWindow(hwnd, SW_SHOW);
            if has_model {
                append_log(hwnd_log, &info_text);
                append_log(hwnd_log, "Click 'Start Export' to begin (Bazis is already free and responsive).");
            }

            let mut msg: MSG = std::mem::zeroed();
            while GetMessageW(&mut msg, null_mut(), 0, 0) > 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
    }
}
