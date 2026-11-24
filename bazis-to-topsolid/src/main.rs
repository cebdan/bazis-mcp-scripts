#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod model;
#[cfg(windows)]
mod com;
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
        match load_model(&json_path) {
            Ok(mut m) => {
                if let Some(pos) = args.iter().position(|a| a == "--out") {
                    if let Some(p) = args.get(pos + 1) {
                        m.save_top_path = p.clone();
                    }
                }
                let cancel = std::sync::atomic::AtomicBool::new(false);
                match exporter::run_export(&m, mode, auto_save || !m.save_top_path.is_empty(), &cancel, |d, t, msg| {
                    println!("[{}/{}] {}", d, t, msg);
                }) {
                    Ok(st) => println!(
                        "OK|panels={}|cuts={}|holes={}|variants={}|applied={}|errors={}|saved={}",
                        st.panels,
                        st.cuts,
                        st.holes,
                        st.variants_built,
                        st.native_applied,
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
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread;

    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
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
        CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, PostMessageW,
        PostQuitMessage, RegisterClassW, SendMessageW, SetWindowTextW, ShowWindow,
        TranslateMessage, BM_GETCHECK, BM_SETCHECK, BS_AUTOCHECKBOX, BS_AUTORADIOBUTTON,
        BS_DEFPUSHBUTTON, BS_PUSHBUTTON, CW_USEDEFAULT, ES_AUTOVSCROLL, ES_MULTILINE, ES_READONLY,
        MSG, SW_SHOW, WM_APP, WM_COMMAND, WM_DESTROY, WM_SETFONT, WNDCLASSW, WS_BORDER,
        WS_CAPTION, WS_CHILD, WS_GROUP, WS_MINIMIZEBOX, WS_OVERLAPPED, WS_SYSMENU, WS_VISIBLE,
        WS_VSCROLL,
    };

    use crate::com::to_wide_null;
    use crate::exporter::{self, ExportMode};
    use crate::load_model;
    use crate::model::BazisExportModel;

    const ID_RADIO_NATIVE: usize = 101;
    const ID_RADIO_FAST: usize = 102;
    const ID_CHK_AUTOSAVE: usize = 103;
    const ID_BTN_START: usize = 104;
    const ID_BTN_STOP: usize = 105;

    const WM_APP_PROGRESS: u32 = WM_APP + 1;
    const WM_APP_DONE: u32 = WM_APP + 2;

    struct AppState {
        hwnd_main: HWND,
        hwnd_radio_native: HWND,
        hwnd_chk_save: HWND,
        hwnd_progress: HWND,
        hwnd_status: HWND,
        hwnd_log: HWND,
        hwnd_start: HWND,
        hwnd_stop: HWND,
        model: Option<BazisExportModel>,
        running: bool,
        cancel: Arc<AtomicBool>,
        pending_logs: Arc<Mutex<Vec<String>>>,
        last_status: Arc<Mutex<String>>,
        prog_cur: Arc<Mutex<(usize, usize)>>,
    }

    static STATE: Mutex<Option<AppState>> = Mutex::new(None);
    unsafe impl Send for AppState {}

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

    fn start_export_worker() {
        let (hwnd_main, model, mode, auto_save, cancel, pending_logs, last_status, prog_cur) = {
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
                None => {
                    append_log(st.hwnd_log, "No model JSON loaded. Run export_topsolid6.js from Bazis 2022.");
                    return;
                }
            };
            let is_native = unsafe { SendMessageW(st.hwnd_radio_native, BM_GETCHECK, 0, 0) } == 1;
            let auto_save = unsafe { SendMessageW(st.hwnd_chk_save, BM_GETCHECK, 0, 0) } == 1;
            st.running = true;
            st.cancel.store(false, Ordering::Relaxed);
            unsafe {
                EnableWindow(st.hwnd_start, 0);
                EnableWindow(st.hwnd_stop, 1);
            }
            append_log(
                st.hwnd_log,
                &format!(
                    "Starting {} export for '{}'...",
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
                st.cancel.clone(),
                st.pending_logs.clone(),
                st.last_status.clone(),
                st.prog_cur.clone(),
            )
        };

        let hwnd_addr = hwnd_main as usize;
        thread::spawn(move || {
            let hwnd = hwnd_addr as HWND;
            let res = exporter::run_export(&model, mode, auto_save, &cancel, |cur, tot, msg| {
                *prog_cur.lock().unwrap() = (cur, tot);
                *last_status.lock().unwrap() = msg.to_string();
                if cur == 0 || cur == tot || cur % 10 == 0 || !msg.starts_with("Use process:") {
                    pending_logs.lock().unwrap().push(format!("[{}/{}] {}", cur, tot, msg));
                }
                unsafe { PostMessageW(hwnd, WM_APP_PROGRESS, 0, 0) };
            });

            match res {
                Ok(st) => {
                    let summary = format!(
                        "DONE! Panels={}, Cuts={}, Holes={}, CachedVariants={}, NativeApplied={}, Errors={}{}",
                        st.panels,
                        st.cuts,
                        st.holes,
                        st.variants_built,
                        st.native_applied,
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
                    let msg = format!("STOPPED/ERROR: {}", e);
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
                    if let Some(st) = STATE.lock().unwrap().as_ref() {
                        st.cancel.store(true, Ordering::Relaxed);
                        set_text(st.hwnd_status, "Stopping...");
                    }
                }
                0
            }
            WM_APP_PROGRESS => {
                if let Some(st) = STATE.lock().unwrap().as_ref() {
                    let (cur, tot) = *st.prog_cur.lock().unwrap();
                    SendMessageW(st.hwnd_progress, PBM_SETRANGE32, 0, tot.max(1) as isize);
                    SendMessageW(st.hwnd_progress, PBM_SETPOS, cur, 0);
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
                if let Some(st) = STATE.lock().unwrap().as_mut() {
                    st.running = false;
                    EnableWindow(st.hwnd_start, 1);
                    EnableWindow(st.hwnd_stop, 0);
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
                sc(640),
                sc(480),
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
                            "Model: {}   |   Panels: {}   |   Grooves/Pockets: {}   |   Holes: {}",
                            m.model_name,
                            m.panels.len(),
                            m.total_cuts(),
                            m.total_holes()
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
                98,
                340,
                22,
                ID_CHK_AUTOSAVE,
            );
            SendMessageW(hwnd_chk_save, BM_SETCHECK, 1, 0);

            let hwnd_start = mk(&btn_cls, "Start Export", BS_DEFPUSHBUTTON as u32, 390, 94, 114, 30, ID_BTN_START);
            let hwnd_stop = mk(&btn_cls, "Stop", BS_PUSHBUTTON as u32, 514, 94, 94, 30, ID_BTN_STOP);
            EnableWindow(hwnd_stop, 0);

            let hwnd_progress = CreateWindowExW(
                0,
                PROGRESS_CLASSW,
                null(),
                WS_CHILD | WS_VISIBLE,
                sc(16),
                sc(136),
                sc(592),
                sc(22),
                hwnd,
                null_mut(),
                hinst,
                null(),
            );
            let hwnd_status = mk(&static_cls, "Ready. Keep TopSolid'Wood 6.25 open.", 0, 16, 166, 592, 22, 0);
            let hwnd_log = mk(
                &edit_cls,
                "",
                WS_BORDER | WS_VSCROLL | ES_MULTILINE as u32 | ES_READONLY as u32 | ES_AUTOVSCROLL as u32,
                16,
                194,
                592,
                232,
                0,
            );

            let has_model = loaded_model.is_some();
            *STATE.lock().unwrap() = Some(AppState {
                hwnd_main: hwnd,
                hwnd_radio_native,
                hwnd_chk_save,
                hwnd_progress,
                hwnd_status,
                hwnd_log,
                hwnd_start,
                hwnd_stop,
                model: loaded_model,
                running: false,
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
