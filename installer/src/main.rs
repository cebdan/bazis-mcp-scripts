#![cfg_attr(windows, windows_subsystem = "windows")]

#[cfg(not(windows))]
fn main() {
    eprintln!("Bazis_TopSolid_Setup.exe must be compiled for Windows (x86_64-pc-windows-msvc).");
}

#[cfg(windows)]
fn main() {
    win_setup::run();
}

#[cfg(windows)]
mod win_setup {
    use std::ffi::OsStr;
    use std::fs;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::process::CommandExt;
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};
    use std::ptr::{null, null_mut};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread;

    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, MAX_PATH, WPARAM};
    use windows_sys::Win32::Graphics::Gdi::{
        CreateFontW, GetDC, GetDeviceCaps, ReleaseDC, COLOR_BTNFACE, DEFAULT_CHARSET,
        DEFAULT_PITCH, FF_SWISS, FW_BOLD, FW_NORMAL, HFONT, LOGPIXELSX,
    };
    use windows_sys::Win32::System::Com::{CoInitializeEx, CoTaskMemFree, COINIT_APARTMENTTHREADED};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::Controls::{
        InitCommonControlsEx, INITCOMMONCONTROLSEX, EM_REPLACESEL, EM_SETSEL, ICC_PROGRESS_CLASS,
        PBM_SETPOS, PBM_SETRANGE32, PROGRESS_CLASSW,
    };
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::EnableWindow;
    use windows_sys::Win32::UI::Shell::{
        SHBrowseForFolderW, SHGetPathFromIDListW, BIF_NEWDIALOGSTYLE, BIF_RETURNONLYFSDIRS,
        BROWSEINFOW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, GetSystemMetrics,
        GetWindowLongPtrW, GetWindowTextLengthW, GetWindowTextW, LoadCursorW, MessageBoxW,
        PostMessageW, PostQuitMessage, RegisterClassW, SendMessageW, SetProcessDPIAware,
        SetWindowLongPtrW, SetWindowTextW, ShowWindow, TranslateMessage, BM_GETCHECK, BM_SETCHECK,
        BS_AUTOCHECKBOX, BS_DEFPUSHBUTTON, BS_PUSHBUTTON, CS_HREDRAW, CS_VREDRAW, ES_AUTOHSCROLL,
        ES_AUTOVSCROLL, ES_MULTILINE, ES_READONLY, GWLP_USERDATA, IDC_ARROW, MB_ICONERROR,
        MB_ICONINFORMATION, MB_OK, MSG, SM_CXSCREEN, SM_CYSCREEN, SW_SHOW, WM_APP, WM_CLOSE,
        WM_COMMAND, WM_DESTROY, WM_SETFONT, WNDCLASSW, WS_BORDER, WS_CAPTION, WS_CHILD,
        WS_CLIPCHILDREN, WS_MINIMIZEBOX, WS_SYSMENU, WS_TABSTOP, WS_VISIBLE, WS_VSCROLL,
    };

    const APP_VERSION: &str = "1.4.0";
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    // Embedded payload files
    const EXPORT_TOPSOLID6_JS: &[u8] = include_bytes!("../../scripts/export_topsolid6.js");
    const EXPORT_MATERIALS_JS: &[u8] =
        include_bytes!("../../scripts/export_bazis_materials_to_topsolid.js");
    const ORDER_NUMBERING_JS: &[u8] = include_bytes!("../../scripts/order_unit_numbering.js");
    const BAZIS_TO_TOPSOLID_EXE: &[u8] =
        include_bytes!("../../bazis-to-topsolid/target/x86_64-pc-windows-msvc/release/bazis-to-topsolid.exe");
    const BAZIS_BRIDGE_JS: &[u8] = include_bytes!("../../agent/bridge.js");
    const BAZIS_SERVER_MJS: &[u8] = include_bytes!("../../server/index.mjs");
    const BAZIS_SERVER_PKG: &[u8] = include_bytes!("../../server/package.json");
    const TOPSOLID_MCP_SETUP_EXE: &[u8] =
        include_bytes!("../../topsolid-mcp/TopSolid_MCP_Setup.exe");

    const ID_EDIT_SCRIPTS: usize = 101;
    const ID_BTN_BROWSE_SCRIPTS: usize = 102;
    const ID_EDIT_PROJECTS: usize = 103;
    const ID_BTN_BROWSE_PROJECTS: usize = 104;
    const ID_EDIT_BAZIS_MCP: usize = 105;
    const ID_BTN_BROWSE_MCP: usize = 106;
    const ID_CHK_EXPORT: usize = 107;
    const ID_CHK_NUMBERING: usize = 108;
    const ID_CHK_BAZIS_MCP: usize = 109;
    const ID_CHK_FOLDERS: usize = 110;
    const ID_CHK_TS_MCP: usize = 111;
    const ID_BTN_TS_MCP_NOW: usize = 112;
    const ID_BTN_INSTALL: usize = 113;
    const ID_BTN_CLOSE: usize = 114;

    const WM_APP_PROGRESS: u32 = WM_APP + 1;
    const WM_APP_DONE: u32 = WM_APP + 2;
    const WM_APP_ERROR: u32 = WM_APP + 3;

    struct InstallOptions {
        bazis_scripts_dir: PathBuf,
        topsolid_projects_dir: PathBuf,
        bazis_mcp_dir: PathBuf,
        install_export: bool,
        install_numbering: bool,
        install_bazis_mcp: bool,
        create_folders: bool,
        launch_topsolid_mcp_setup: bool,
    }

    struct UiState {
        hwnd_scripts: HWND,
        hwnd_projects: HWND,
        hwnd_bazis_mcp: HWND,
        hwnd_ts_status: HWND,
        hwnd_chk_export: HWND,
        hwnd_chk_numbering: HWND,
        hwnd_chk_bazis_mcp: HWND,
        hwnd_chk_folders: HWND,
        hwnd_chk_ts_mcp: HWND,
        hwnd_btn_ts_now: HWND,
        hwnd_btn_install: HWND,
        hwnd_btn_close: HWND,
        hwnd_progress: HWND,
        hwnd_log: HWND,
        installing: Arc<AtomicBool>,
        pending_logs: Arc<Mutex<Vec<String>>>,
        last_error: Arc<Mutex<String>>,
    }

    fn to_wide(s: &str) -> Vec<u16> {
        OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    fn get_text(hwnd: HWND) -> String {
        unsafe {
            let len = GetWindowTextLengthW(hwnd);
            if len <= 0 {
                return String::new();
            }
            let mut buf = vec![0u16; (len + 1) as usize];
            let n = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
            String::from_utf16_lossy(&buf[..n.max(0) as usize])
        }
    }

    fn set_text(hwnd: HWND, s: &str) {
        let w = to_wide(s);
        unsafe { SetWindowTextW(hwnd, w.as_ptr()) };
    }

    fn is_checked(hwnd: HWND) -> bool {
        unsafe { SendMessageW(hwnd, BM_GETCHECK, 0, 0) == 1 }
    }

    fn append_log(hwnd_log: HWND, line: &str) {
        let mut msg = String::from(line);
        msg.push_str("\r\n");
        let w = to_wide(&msg);
        unsafe {
            SendMessageW(hwnd_log, EM_SETSEL, usize::MAX, -1);
            SendMessageW(hwnd_log, EM_REPLACESEL, 0, w.as_ptr() as isize);
        }
    }

    fn browse_folder(owner: HWND, title: &str) -> Option<String> {
        let w_title = to_wide(title);
        let mut display_buf = [0u16; MAX_PATH as usize];
        let mut bi: BROWSEINFOW = unsafe { std::mem::zeroed() };
        bi.hwndOwner = owner;
        bi.pszDisplayName = display_buf.as_mut_ptr();
        bi.lpszTitle = w_title.as_ptr();
        bi.ulFlags = BIF_RETURNONLYFSDIRS | BIF_NEWDIALOGSTYLE;
        unsafe {
            let pidl = SHBrowseForFolderW(&mut bi);
            if pidl.is_null() {
                return None;
            }
            let mut path_buf = [0u16; MAX_PATH as usize];
            let ok = SHGetPathFromIDListW(pidl, path_buf.as_mut_ptr());
            CoTaskMemFree(pidl as *const _);
            if ok != 0 {
                let len = path_buf.iter().position(|&c| c == 0).unwrap_or(path_buf.len());
                Some(String::from_utf16_lossy(&path_buf[..len]))
            } else {
                None
            }
        }
    }

    fn detect_default_bazis_scripts_dir() -> String {
        let user_prof = std::env::var("USERPROFILE").unwrap_or_else(|_| r"C:\Users\Public".into());
        let candidates = [
            PathBuf::from(r"Y:\Works\bazis\Scripts"),
            PathBuf::from(&user_prof).join("Documents").join("Bazis").join("Scripts"),
            PathBuf::from(&user_prof).join("Documents").join("Bazis2022").join("Scripts"),
        ];
        for c in &candidates {
            if c.exists() {
                return c.to_string_lossy().to_string();
            }
        }
        candidates[1].to_string_lossy().to_string()
    }

    fn detect_default_projects_dir() -> String {
        let user_prof = std::env::var("USERPROFILE").unwrap_or_else(|_| r"C:\Users\Public".into());
        let candidates = [
            PathBuf::from(r"Y:\Works\bazis\Projects"),
            PathBuf::from(&user_prof).join("Documents").join("TopSolid_Projects"),
        ];
        for c in &candidates {
            if c.exists() {
                return c.to_string_lossy().to_string();
            }
        }
        candidates[1].to_string_lossy().to_string()
    }

    fn detect_default_bazis_mcp_dir() -> String {
        if Path::new(r"C:\Missler").exists() {
            return r"C:\Missler\bazis-mcp".to_string();
        }
        let local = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| r"C:\ProgramData".into());
        PathBuf::from(local).join("bazis-mcp").to_string_lossy().to_string()
    }

    fn detect_topsolid_mcp_install() -> Option<String> {
        let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
        let candidates = [
            PathBuf::from(r"C:\Missler\mcp\agent\ts6_bridge.ps1"),
            PathBuf::from(&local).join("TopSolid6MCP").join("agent").join("ts6_bridge.ps1"),
            PathBuf::from(r"D:\Missler\mcp\agent\ts6_bridge.ps1"),
        ];
        for c in &candidates {
            if c.exists() {
                if let Some(root) = c.parent().and_then(|p| p.parent()) {
                    return Some(root.to_string_lossy().to_string());
                }
            }
        }
        None
    }

    fn launch_embedded_topsolid_mcp_setup() -> Result<String, String> {
        let tmp_exe = std::env::temp_dir().join("TopSolid_MCP_Setup.exe");
        fs::write(&tmp_exe, TOPSOLID_MCP_SETUP_EXE)
            .map_err(|e| format!("Failed to extract TopSolid_MCP_Setup.exe: {}", e))?;
        Command::new(&tmp_exe)
            .spawn()
            .map_err(|e| format!("Failed to launch TopSolid_MCP_Setup.exe: {}", e))?;
        Ok(tmp_exe.to_string_lossy().to_string())
    }

    fn json_escape_path(p: &Path) -> String {
        p.to_string_lossy()
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
    }

    fn register_bazis_mcp_in_antigravity(mcp_dir: &Path) -> Result<(), String> {
        let server_js = mcp_dir.join("server").join("index.mjs");
        let ipc_dir = mcp_dir.join(".bridge-ipc");
        let server_esc = server_js.to_string_lossy().replace('\'', "''");
        let ipc_esc = ipc_dir.to_string_lossy().replace('\'', "''");
        let ps = format!(
            "$cfg = Join-Path $env:USERPROFILE '.gemini\\antigravity\\mcp_config.json'; \
             $dir = Split-Path -Parent $cfg; \
             if (-not (Test-Path $dir)) {{ New-Item -ItemType Directory -Force -Path $dir | Out-Null }}; \
             $obj = if (Test-Path $cfg) {{ try {{ Get-Content -Raw -Encoding UTF8 $cfg | ConvertFrom-Json }} catch {{ [pscustomobject]@{{}} }} }} else {{ [pscustomobject]@{{}} }}; \
             if (-not ($obj.PSObject.Properties.Name -contains 'mcpServers')) {{ $obj | Add-Member -NotePropertyName mcpServers -NotePropertyValue ([pscustomobject]@{{}}) }}; \
             $entry = [pscustomobject]@{{ command = 'node'; args = @('{}'); env = [pscustomobject]@{{ BAZIS_BRIDGE_IPC_DIR = '{}' }} }}; \
             $obj.mcpServers | Add-Member -Force -NotePropertyName 'bazis-mcp' -NotePropertyValue $entry; \
             $obj | ConvertTo-Json -Depth 10 | Set-Content -Path $cfg -Encoding UTF8",
            server_esc, ipc_esc
        );
        let st = Command::new("powershell.exe")
            .args(["-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-Command", &ps])
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|e| format!("PowerShell failed: {}", e))?;
        if st.success() {
            Ok(())
        } else {
            Err("Failed to update Antigravity mcp_config.json".to_string())
        }
    }

    fn run_install<F>(opts: &InstallOptions, mut log: F) -> Result<(), String>
    where
        F: FnMut(i32, &str),
    {
        let scripts_dir = &opts.bazis_scripts_dir;
        let projects_dir = &opts.topsolid_projects_dir;
        let bazis_root = scripts_dir
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| scripts_dir.clone());
        let templates_dir = bazis_root.join("TopSolid_Templates");
        let templates_cache = templates_dir.join("cache");
        let hw_lib_dir = bazis_root.join("TopSolid_Lib_Bazis");
        let missler_tex_dir = PathBuf::from(r"C:\Missler\Config\Textures\Bazis");

        log(10, "Creating required directories...");
        fs::create_dir_all(scripts_dir)
            .map_err(|e| format!("Cannot create Bazis Scripts folder {:?}: {}", scripts_dir, e))?;
        fs::create_dir_all(projects_dir)
            .map_err(|e| format!("Cannot create TopSolid Projects folder {:?}: {}", projects_dir, e))?;

        if opts.create_folders {
            let _ = fs::create_dir_all(&templates_dir);
            let _ = fs::create_dir_all(&templates_cache);
            let _ = fs::create_dir_all(&hw_lib_dir);
            let _ = fs::create_dir_all(&missler_tex_dir);
            log(20, &format!("  OK: {}", templates_dir.display()));
            log(22, &format!("  OK: {}", hw_lib_dir.display()));
            log(24, &format!("  OK: {}", projects_dir.display()));
            log(26, &format!("  OK: {}", missler_tex_dir.display()));
        }

        // Write bazis_export_config.json so export_topsolid6.js uses user-selected folders
        let cfg_path = scripts_dir.join("bazis_export_config.json");
        let cfg_json = format!(
            "{{\r\n  \"projectsDir\": \"{}\",\r\n  \"templatesDir\": \"{}\",\r\n  \"hardwareLibDir\": \"{}\"\r\n}}\r\n",
            json_escape_path(projects_dir),
            json_escape_path(&templates_dir),
            json_escape_path(&hw_lib_dir)
        );
        fs::write(&cfg_path, cfg_json.as_bytes())
            .map_err(|e| format!("Cannot write {:?}: {}", cfg_path, e))?;
        log(32, &format!("Saved config: {}", cfg_path.display()));

        if opts.install_export {
            log(40, "Installing TopSolid Export scripts & bazis-to-topsolid.exe...");
            fs::write(scripts_dir.join("export_topsolid6.js"), EXPORT_TOPSOLID6_JS)
                .map_err(|e| format!("Write export_topsolid6.js failed: {}", e))?;
            fs::write(
                scripts_dir.join("export_bazis_materials_to_topsolid.js"),
                EXPORT_MATERIALS_JS,
            )
            .map_err(|e| format!("Write export_bazis_materials_to_topsolid.js failed: {}", e))?;
            fs::write(scripts_dir.join("bazis-to-topsolid.exe"), BAZIS_TO_TOPSOLID_EXE)
                .map_err(|e| format!("Write bazis-to-topsolid.exe failed (close it if open): {}", e))?;
            log(55, "  OK: export_topsolid6.js, export_bazis_materials_to_topsolid.js, bazis-to-topsolid.exe");
        }

        if opts.install_numbering {
            log(62, "Installing Order Unit Numbering script...");
            fs::write(scripts_dir.join("order_unit_numbering.js"), ORDER_NUMBERING_JS)
                .map_err(|e| format!("Write order_unit_numbering.js failed: {}", e))?;
            log(68, "  OK: order_unit_numbering.js (Approve / Skip interactive UI)");
        }

        if opts.install_bazis_mcp {
            log(74, "Installing Bazis MCP Bridge & Server...");
            let mcp_dir = &opts.bazis_mcp_dir;
            let mcp_agent = mcp_dir.join("agent");
            let mcp_server = mcp_dir.join("server");
            let mcp_ipc = mcp_dir.join(".bridge-ipc");
            fs::create_dir_all(&mcp_agent)
                .map_err(|e| format!("Cannot create {:?}: {}", mcp_agent, e))?;
            fs::create_dir_all(&mcp_server)
                .map_err(|e| format!("Cannot create {:?}: {}", mcp_server, e))?;
            let _ = fs::create_dir_all(&mcp_ipc);

            fs::write(scripts_dir.join("bridge.js"), BAZIS_BRIDGE_JS)
                .map_err(|e| format!("Write Scripts\\bridge.js failed: {}", e))?;
            fs::write(mcp_agent.join("bridge.js"), BAZIS_BRIDGE_JS)
                .map_err(|e| format!("Write agent\\bridge.js failed: {}", e))?;
            fs::write(mcp_server.join("index.mjs"), BAZIS_SERVER_MJS)
                .map_err(|e| format!("Write server\\index.mjs failed: {}", e))?;
            fs::write(mcp_server.join("package.json"), BAZIS_SERVER_PKG)
                .map_err(|e| format!("Write server\\package.json failed: {}", e))?;
            log(84, &format!("  OK: bridge.js + MCP server in {}", mcp_dir.display()));

            match register_bazis_mcp_in_antigravity(mcp_dir) {
                Ok(_) => log(90, "  OK: Registered bazis-mcp in Antigravity mcp_config.json"),
                Err(e) => log(90, &format!("  WARN: {}", e)),
            }
        }

        if opts.launch_topsolid_mcp_setup {
            log(95, "Launching TopSolid_MCP_Setup.exe...");
            match launch_embedded_topsolid_mcp_setup() {
                Ok(p) => log(98, &format!("  Launched: {}", p)),
                Err(e) => log(98, &format!("  WARN: {}", e)),
            }
        }

        log(100, "Installation completed successfully!");
        Ok(())
    }

    unsafe extern "system" fn wnd_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut UiState;
        match msg {
            WM_COMMAND => {
                if !ptr.is_null() {
                    let st = &*ptr;
                    let id = wparam & 0xFFFF;
                    match id {
                        ID_BTN_BROWSE_SCRIPTS => {
                            if let Some(p) = browse_folder(hwnd, "Select Bazis Scripts Folder") {
                                set_text(st.hwnd_scripts, &p);
                            }
                        }
                        ID_BTN_BROWSE_PROJECTS => {
                            if let Some(p) = browse_folder(hwnd, "Select TopSolid Projects Folder") {
                                set_text(st.hwnd_projects, &p);
                            }
                        }
                        ID_BTN_BROWSE_MCP => {
                            if let Some(p) = browse_folder(hwnd, "Select Bazis MCP Install Folder") {
                                set_text(st.hwnd_bazis_mcp, &p);
                            }
                        }
                        ID_BTN_TS_MCP_NOW => match launch_embedded_topsolid_mcp_setup() {
                            Ok(p) => append_log(st.hwnd_log, &format!("Launched TopSolid MCP Setup: {}", p)),
                            Err(e) => {
                                let w_t = to_wide("TopSolid MCP Setup Error");
                                let w_b = to_wide(&e);
                                MessageBoxW(hwnd, w_b.as_ptr(), w_t.as_ptr(), MB_OK | MB_ICONERROR);
                            }
                        },
                        ID_BTN_INSTALL => {
                            if st.installing.swap(true, Ordering::SeqCst) {
                                return 0;
                            }
                            let opts = InstallOptions {
                                bazis_scripts_dir: PathBuf::from(get_text(st.hwnd_scripts).trim()),
                                topsolid_projects_dir: PathBuf::from(get_text(st.hwnd_projects).trim()),
                                bazis_mcp_dir: PathBuf::from(get_text(st.hwnd_bazis_mcp).trim()),
                                install_export: is_checked(st.hwnd_chk_export),
                                install_numbering: is_checked(st.hwnd_chk_numbering),
                                install_bazis_mcp: is_checked(st.hwnd_chk_bazis_mcp),
                                create_folders: is_checked(st.hwnd_chk_folders),
                                launch_topsolid_mcp_setup: is_checked(st.hwnd_chk_ts_mcp),
                            };
                            EnableWindow(st.hwnd_btn_install, 0);
                            EnableWindow(st.hwnd_btn_close, 0);
                            SendMessageW(st.hwnd_progress, PBM_SETPOS, 0, 0);
                            append_log(st.hwnd_log, "Starting installation...");

                            let hwnd_val = hwnd as usize;
                            let pending = st.pending_logs.clone();
                            let last_err = st.last_error.clone();
                            let installing_flag = st.installing.clone();
                            thread::spawn(move || {
                                let h = hwnd_val as HWND;
                                let res = run_install(&opts, |pct, line| {
                                    pending.lock().unwrap().push(line.to_string());
                                    PostMessageW(h, WM_APP_PROGRESS, pct as usize, 0);
                                });
                                installing_flag.store(false, Ordering::SeqCst);
                                match res {
                                    Ok(()) => {
                                        PostMessageW(h, WM_APP_DONE, 0, 0);
                                    }
                                    Err(e) => {
                                        *last_err.lock().unwrap() = e;
                                        PostMessageW(h, WM_APP_ERROR, 0, 0);
                                    }
                                }
                            });
                        }
                        ID_BTN_CLOSE => {
                            PostMessageW(hwnd, WM_CLOSE, 0, 0);
                        }
                        _ => {}
                    }
                }
                0
            }
            WM_APP_PROGRESS => {
                if !ptr.is_null() {
                    let st = &*ptr;
                    SendMessageW(st.hwnd_progress, PBM_SETPOS, wparam, 0);
                    let mut logs = st.pending_logs.lock().unwrap();
                    for l in logs.drain(..) {
                        append_log(st.hwnd_log, &l);
                    }
                }
                0
            }
            WM_APP_DONE => {
                if !ptr.is_null() {
                    let st = &*ptr;
                    EnableWindow(st.hwnd_btn_install, 1);
                    EnableWindow(st.hwnd_btn_close, 1);
                    let ts_info = match detect_topsolid_mcp_install() {
                        Some(p) => format!("TopSolid MCP: INSTALLED ({})", p),
                        None => "TopSolid MCP: NOT INSTALLED".to_string(),
                    };
                    set_text(st.hwnd_ts_status, &ts_info);
                    let w_t = to_wide("Bazis -> TopSolid Setup Complete");
                    let w_b = to_wide("Installation completed successfully!\r\nYou can now run Scripts -> export_topsolid6.js and order_unit_numbering.js in Bazis 2022.");
                    MessageBoxW(hwnd, w_b.as_ptr(), w_t.as_ptr(), MB_OK | MB_ICONINFORMATION);
                }
                0
            }
            WM_APP_ERROR => {
                if !ptr.is_null() {
                    let st = &*ptr;
                    EnableWindow(st.hwnd_btn_install, 1);
                    EnableWindow(st.hwnd_btn_close, 1);
                    let err = st.last_error.lock().unwrap().clone();
                    append_log(st.hwnd_log, &format!("ERROR: {}", err));
                    let w_t = to_wide("Installation Error");
                    let w_b = to_wide(&err);
                    MessageBoxW(hwnd, w_b.as_ptr(), w_t.as_ptr(), MB_OK | MB_ICONERROR);
                }
                0
            }
            WM_CLOSE => {
                if !ptr.is_null() && (*ptr).installing.load(Ordering::SeqCst) {
                    return 0;
                }
                PostQuitMessage(0);
                0
            }
            WM_DESTROY => {
                PostQuitMessage(0);
                0
            }
            _ => DefWindowProcW(hwnd, msg, wparam, lparam),
        }
    }

    pub fn run() {
        let args: Vec<String> = std::env::args().collect();
        if args.iter().any(|a| a.eq_ignore_ascii_case("/S") || a == "--silent") {
            let opts = InstallOptions {
                bazis_scripts_dir: PathBuf::from(detect_default_bazis_scripts_dir()),
                topsolid_projects_dir: PathBuf::from(detect_default_projects_dir()),
                bazis_mcp_dir: PathBuf::from(detect_default_bazis_mcp_dir()),
                install_export: true,
                install_numbering: true,
                install_bazis_mcp: true,
                create_folders: true,
                launch_topsolid_mcp_setup: false,
            };
            let _ = run_install(&opts, |_, _| {});
            return;
        }

        unsafe {
            SetProcessDPIAware();
            let _ = CoInitializeEx(null(), COINIT_APARTMENTTHREADED as u32);
            let icc = INITCOMMONCONTROLSEX {
                dwSize: std::mem::size_of::<INITCOMMONCONTROLSEX>() as u32,
                dwICC: ICC_PROGRESS_CLASS,
            };
            InitCommonControlsEx(&icc);

            let hdc = GetDC(null_mut());
            let dpi = if !hdc.is_null() {
                let d = GetDeviceCaps(hdc, LOGPIXELSX as i32);
                ReleaseDC(null_mut(), hdc);
                d.max(96)
            } else {
                96
            };
            let sc = |v: i32| -> i32 { (v * dpi + 48) / 96 };

            let hinst = GetModuleHandleW(null());
            let cls_name = to_wide("BazisTopSolidAllInOneSetupWnd");
            let wc = WNDCLASSW {
                style: CS_HREDRAW | CS_VREDRAW,
                lpfnWndProc: Some(wnd_proc),
                cbClsExtra: 0,
                cbWndExtra: 0,
                hInstance: hinst,
                hIcon: null_mut(),
                hCursor: LoadCursorW(null_mut(), IDC_ARROW),
                hbrBackground: (COLOR_BTNFACE + 1) as _,
                lpszMenuName: null(),
                lpszClassName: cls_name.as_ptr(),
            };
            RegisterClassW(&wc);

            let win_w = sc(680);
            let win_h = sc(610);
            let scr_w = GetSystemMetrics(SM_CXSCREEN);
            let scr_h = GetSystemMetrics(SM_CYSCREEN);
            let wx = ((scr_w - win_w) / 2).max(0);
            let wy = ((scr_h - win_h) / 2).max(0);

            let title = to_wide(&format!(
                "Bazis -> TopSolid'Wood 6.25 All-in-One Setup (v{})",
                APP_VERSION
            ));
            let hwnd = CreateWindowExW(
                0,
                cls_name.as_ptr(),
                title.as_ptr(),
                WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX | WS_CLIPCHILDREN | WS_VISIBLE,
                wx,
                wy,
                win_w,
                win_h,
                null_mut(),
                null_mut(),
                hinst,
                null(),
            );

            let font_face = to_wide("Segoe UI");
            let font_norm: HFONT = CreateFontW(
                -sc(13), 0, 0, 0, FW_NORMAL as i32, 0, 0, 0, DEFAULT_CHARSET as u32,
                0, 0, 0, (DEFAULT_PITCH | FF_SWISS) as u32, font_face.as_ptr(),
            );
            let font_bold: HFONT = CreateFontW(
                -sc(16), 0, 0, 0, FW_BOLD as i32, 0, 0, 0, DEFAULT_CHARSET as u32,
                0, 0, 0, (DEFAULT_PITCH | FF_SWISS) as u32, font_face.as_ptr(),
            );

            let static_cls = to_wide("STATIC");
            let edit_cls = to_wide("EDIT");
            let btn_cls = to_wide("BUTTON");

            let mk = |cls: &[u16], text: &str, style: u32, x: i32, y: i32, w: i32, h: i32, id: usize, f: HFONT| -> HWND {
                let wt = to_wide(text);
                let c = CreateWindowExW(
                    0, cls.as_ptr(), wt.as_ptr(), WS_CHILD | WS_VISIBLE | style,
                    sc(x), sc(y), sc(w), sc(h), hwnd, id as _, hinst, null(),
                );
                SendMessageW(c, WM_SETFONT, f as usize, 1);
                c
            };

            let _hdr = mk(&static_cls, "Bazis 2022 -> TopSolid'Wood 6.25 Suite Installer", 0, 18, 14, 620, 24, 0, font_bold);

            let ts_mcp_found = detect_topsolid_mcp_install();
            let ts_status_text = match &ts_mcp_found {
                Some(p) => format!("TopSolid MCP Status: INSTALLED ({})", p),
                None => "TopSolid MCP Status: NOT INSTALLED (recommended — will launch TopSolid_MCP_Setup.exe)".to_string(),
            };
            let hwnd_ts_status = mk(&static_cls, &ts_status_text, 0, 18, 42, 620, 20, 0, font_norm);

            // Folder 1: Bazis Scripts
            let _l1 = mk(&static_cls, "Bazis 2022 Scripts folder:", 0, 18, 72, 260, 18, 0, font_norm);
            let hwnd_scripts = mk(
                &edit_cls, &detect_default_bazis_scripts_dir(),
                WS_BORDER | WS_TABSTOP | ES_AUTOHSCROLL as u32,
                18, 92, 540, 24, ID_EDIT_SCRIPTS, font_norm,
            );
            let _b1 = mk(&btn_cls, "Browse...", BS_PUSHBUTTON as u32 | WS_TABSTOP, 566, 91, 86, 26, ID_BTN_BROWSE_SCRIPTS, font_norm);

            // Folder 2: TopSolid Projects
            let _l2 = mk(&static_cls, "TopSolid Projects folder (default .top export destination):", 0, 18, 126, 420, 18, 0, font_norm);
            let hwnd_projects = mk(
                &edit_cls, &detect_default_projects_dir(),
                WS_BORDER | WS_TABSTOP | ES_AUTOHSCROLL as u32,
                18, 146, 540, 24, ID_EDIT_PROJECTS, font_norm,
            );
            let _b2 = mk(&btn_cls, "Browse...", BS_PUSHBUTTON as u32 | WS_TABSTOP, 566, 145, 86, 26, ID_BTN_BROWSE_PROJECTS, font_norm);

            // Folder 3: Bazis MCP Server
            let _l3 = mk(&static_cls, "Bazis MCP Server folder (bridge + Node.js MCP server):", 0, 18, 180, 420, 18, 0, font_norm);
            let hwnd_bazis_mcp = mk(
                &edit_cls, &detect_default_bazis_mcp_dir(),
                WS_BORDER | WS_TABSTOP | ES_AUTOHSCROLL as u32,
                18, 200, 540, 24, ID_EDIT_BAZIS_MCP, font_norm,
            );
            let _b3 = mk(&btn_cls, "Browse...", BS_PUSHBUTTON as u32 | WS_TABSTOP, 566, 199, 86, 26, ID_BTN_BROWSE_MCP, font_norm);

            // Component Checkboxes
            let hwnd_chk_export = mk(
                &btn_cls,
                "Install TopSolid Export (export_topsolid6.js + bazis-to-topsolid.exe + materials sync)",
                BS_AUTOCHECKBOX as u32 | WS_TABSTOP,
                18, 238, 630, 22, ID_CHK_EXPORT, font_norm,
            );
            SendMessageW(hwnd_chk_export, BM_SETCHECK, 1, 0);

            let hwnd_chk_numbering = mk(
                &btn_cls,
                "Install Order Unit Numbering script (order_unit_numbering.js with Approve / Skip)",
                BS_AUTOCHECKBOX as u32 | WS_TABSTOP,
                18, 264, 630, 22, ID_CHK_NUMBERING, font_norm,
            );
            SendMessageW(hwnd_chk_numbering, BM_SETCHECK, 1, 0);

            let hwnd_chk_bazis_mcp = mk(
                &btn_cls,
                "Install Bazis MCP (bridge.js + MCP server + Antigravity mcp_config.json registration)",
                BS_AUTOCHECKBOX as u32 | WS_TABSTOP,
                18, 290, 630, 22, ID_CHK_BAZIS_MCP, font_norm,
            );
            SendMessageW(hwnd_chk_bazis_mcp, BM_SETCHECK, 1, 0);

            let hwnd_chk_folders = mk(
                &btn_cls,
                "Create required folders (TopSolid_Templates, cache, TopSolid_Lib_Bazis, Projects, Textures\\Bazis)",
                BS_AUTOCHECKBOX as u32 | WS_TABSTOP,
                18, 316, 630, 22, ID_CHK_FOLDERS, font_norm,
            );
            SendMessageW(hwnd_chk_folders, BM_SETCHECK, 1, 0);

            let hwnd_chk_ts_mcp = mk(
                &btn_cls,
                "Launch TopSolid MCP Setup (TopSolid_MCP_Setup.exe) after installation",
                BS_AUTOCHECKBOX as u32 | WS_TABSTOP,
                18, 342, 430, 22, ID_CHK_TS_MCP, font_norm,
            );
            if ts_mcp_found.is_none() {
                SendMessageW(hwnd_chk_ts_mcp, BM_SETCHECK, 1, 0);
            }

            let hwnd_btn_ts_now = mk(
                &btn_cls,
                "Install TopSolid MCP Now...",
                BS_PUSHBUTTON as u32 | WS_TABSTOP,
                458, 338, 194, 28, ID_BTN_TS_MCP_NOW, font_norm,
            );

            // Progress & Log
            let hwnd_progress = CreateWindowExW(
                0, PROGRESS_CLASSW, null(), WS_CHILD | WS_VISIBLE,
                sc(18), sc(378), sc(634), sc(20), hwnd, null_mut(), hinst, null(),
            );
            SendMessageW(hwnd_progress, PBM_SETRANGE32, 0, 100);

            let hwnd_log = mk(
                &edit_cls,
                "Ready. Select folders and components, then click Install.",
                WS_BORDER | WS_VSCROLL | ES_MULTILINE as u32 | ES_READONLY as u32 | ES_AUTOVSCROLL as u32,
                18, 408, 634, 114, 0, font_norm,
            );

            let hwnd_btn_install = mk(
                &btn_cls, "Install", BS_DEFPUSHBUTTON as u32 | WS_TABSTOP,
                442, 532, 104, 32, ID_BTN_INSTALL, font_norm,
            );
            let hwnd_btn_close = mk(
                &btn_cls, "Close", BS_PUSHBUTTON as u32 | WS_TABSTOP,
                556, 532, 96, 32, ID_BTN_CLOSE, font_norm,
            );

            let state = Box::new(UiState {
                hwnd_scripts,
                hwnd_projects,
                hwnd_bazis_mcp,
                hwnd_ts_status,
                hwnd_chk_export,
                hwnd_chk_numbering,
                hwnd_chk_bazis_mcp,
                hwnd_chk_folders,
                hwnd_chk_ts_mcp,
                hwnd_btn_ts_now,
                hwnd_btn_install,
                hwnd_btn_close,
                hwnd_progress,
                hwnd_log,
                installing: Arc::new(AtomicBool::new(false)),
                pending_logs: Arc::new(Mutex::new(Vec::new())),
                last_error: Arc::new(Mutex::new(String::new())),
            });
            let state_ptr = Box::into_raw(state);
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, state_ptr as isize);

            ShowWindow(hwnd, SW_SHOW);
            let mut msg: MSG = std::mem::zeroed();
            while GetMessageW(&mut msg, null_mut(), 0, 0) > 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            drop(Box::from_raw(state_ptr));
        }
    }
}
