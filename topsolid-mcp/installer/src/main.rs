#![cfg_attr(windows, windows_subsystem = "windows")]

#[cfg(not(windows))]
fn main() {
    eprintln!("TopSolid6_MCP_Setup.exe must be compiled for Windows (x86_64-pc-windows-msvc).");
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
    use std::sync::Arc;
    use std::thread;

    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::Graphics::Gdi::{
        CreateFontW, GetDC, GetDeviceCaps, ReleaseDC, COLOR_BTNFACE, DEFAULT_CHARSET,
        DEFAULT_PITCH, FF_SWISS, FW_BOLD, FW_NORMAL, HFONT, LOGPIXELSX,
    };
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, REG_DWORD, REG_SZ,
    };
    use windows_sys::Win32::UI::Controls::{
        InitCommonControlsEx, INITCOMMONCONTROLSEX, ICC_PROGRESS_CLASS, PBM_SETPOS, PBM_SETRANGE32,
    };
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::EnableWindow;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW,
        GetSystemMetrics, GetWindowLongPtrW, GetWindowTextLengthW, GetWindowTextW, LoadCursorW,
        LoadImageW, MessageBoxW, PostMessageW, PostQuitMessage, RegisterClassW, SendMessageW,
        SetProcessDPIAware, SetWindowLongPtrW, SetWindowTextW, ShowWindow, TranslateMessage,
        BM_GETCHECK, BM_SETCHECK, BS_AUTOCHECKBOX, BS_DEFPUSHBUTTON, BS_PUSHBUTTON, CS_HREDRAW,
        CS_VREDRAW, ES_AUTOHSCROLL, GWLP_USERDATA, IDC_ARROW, IMAGE_ICON, LR_DEFAULTSIZE,
        LR_LOADFROMFILE, MB_ICONERROR, MB_ICONINFORMATION, MB_OK, MSG, SM_CXSCREEN, SM_CYSCREEN,
        SW_SHOW, WM_APP, WM_CLOSE, WM_COMMAND, WM_DESTROY, WM_SETFONT, WM_SETICON, WNDCLASSW,
        WS_BORDER, WS_CAPTION, WS_CHILD, WS_CLIPCHILDREN, WS_MINIMIZEBOX, WS_SYSMENU, WS_TABSTOP,
        WS_VISIBLE, WS_VSCROLL,
    };
    const SS_LEFT: u32 = 0;
    const CBS_DROPDOWN: u32 = 0x0002;
    const CBS_AUTOHSCROLL: u32 = 0x0040;
    const CB_ADDSTRING: u32 = 0x0143;
    const CB_SETCURSEL: u32 = 0x014E;

    const APP_VERSION: &str = "0.3.0";
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    // Embedded payload files from topsolid-mcp/
    const PAYLOAD: &[(&str, &[u8])] = &[
        ("version.json", include_bytes!("../../version.json")),
        ("README.md", include_bytes!("../../README.md")),
        ("assets/ts6_mcp.ico", include_bytes!("../../assets/ts6_mcp.ico")),
        ("agent/ts6_bridge.ps1", include_bytes!("../../agent/ts6_bridge.ps1")),
        ("agent/ts6_tray_launcher.vbs", include_bytes!("../../agent/ts6_tray_launcher.vbs")),
        ("agent/ts6_apply_ops.ps1", include_bytes!("../../agent/ts6_apply_ops.ps1")),
        ("agent/ts6_ensure_deps.ps1", include_bytes!("../../agent/ts6_ensure_deps.ps1")),
        ("agent/ts6_build_templates.ps1", include_bytes!("../../agent/ts6_build_templates.ps1")),
        ("server/core.mjs", include_bytes!("../../server/core.mjs")),
        ("server/http.mjs", include_bytes!("../../server/http.mjs")),
        ("server/index.mjs", include_bytes!("../../server/index.mjs")),
        ("Start_TopSolid6_Bridge.bat", include_bytes!("../../Start_TopSolid6_Bridge.bat")),
        ("Install_TopSolid6_MCP.bat", include_bytes!("../../Install_TopSolid6_MCP.bat")),
        ("Uninstall_TopSolid6_MCP.bat", include_bytes!("../../Uninstall_TopSolid6_MCP.bat")),
    ];

    const ID_EDIT_INSTALL: usize = 101;
    const ID_EDIT_IPC: usize = 102;
    const ID_EDIT_TEMPLATES: usize = 103;
    const ID_CHK_NODE: usize = 104;
    const ID_CHK_AGY: usize = 105;
    const ID_CHK_SERVICE: usize = 106;
    const ID_CHK_STARTMENU: usize = 107;
    const ID_CHK_LAUNCH: usize = 108;
    const ID_BTN_INSTALL: usize = 109;
    const ID_BTN_CANCEL: usize = 110;
    const ID_CMB_TOPSOLID: usize = 111;
    const ID_CHK_TEMPLATES: usize = 112;
    const ID_BTN_REBUILD_TPL: usize = 113;

    const WM_APP_PROGRESS: u32 = WM_APP + 1;
    const WM_APP_DONE: u32 = WM_APP + 2;
    const WM_APP_ERROR: u32 = WM_APP + 3;

    struct InstallOptions {
        install_dir: PathBuf,
        ipc_dir: PathBuf,
        templates_dir: PathBuf,
        topsolid_exe: String,
        ensure_node: bool,
        configure_antigravity: bool,
        build_templates: bool,
        install_service: bool,
        install_start_menu: bool,
        launch_after: bool,
    }

    struct UiState {
        hwnd_install: HWND,
        hwnd_ipc: HWND,
        hwnd_templates: HWND,
        hwnd_cmb_ts: HWND,
        hwnd_chk_node: HWND,
        hwnd_chk_agy: HWND,
        hwnd_chk_tpl: HWND,
        hwnd_chk_svc: HWND,
        hwnd_chk_sm: HWND,
        hwnd_chk_launch: HWND,
        hwnd_btn_rebuild: HWND,
        hwnd_btn_install: HWND,
        hwnd_btn_cancel: HWND,
        hwnd_progress: HWND,
        hwnd_status: HWND,
        installing: Arc<AtomicBool>,
        finished: bool,
    }

    fn discover_topsolid_exes() -> Vec<String> {
        let mut found: Vec<String> = Vec::new();
        let roots = [
            r"C:\Missler",
            r"D:\Missler",
            r"E:\Missler",
            r"C:\Program Files\Missler",
            r"C:\Program Files (x86)\Missler",
        ];
        for root in roots {
            let Ok(rd) = fs::read_dir(root) else { continue };
            for entry in rd.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if !name.to_ascii_uppercase().starts_with("V6") {
                    continue;
                }
                let bin_dir = entry.path().join("bin");
                let Ok(brd) = fs::read_dir(&bin_dir) else { continue };
                for be in brd.flatten() {
                    let bname = be.file_name().to_string_lossy().to_ascii_lowercase();
                    if bname.starts_with("top6") && bname.ends_with(".exe") {
                        let p = be.path().to_string_lossy().to_string();
                        if !found.iter().any(|x| x.eq_ignore_ascii_case(&p)) {
                            found.push(p);
                        }
                    }
                }
            }
        }
        found.sort_by(|a, b| b.cmp(a));
        found
    }

    fn to_wide(s: &str) -> Vec<u16> {
        OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
    }

    unsafe fn get_text(hwnd: HWND) -> String {
        let len = GetWindowTextLengthW(hwnd);
        if len <= 0 {
            return String::new();
        }
        let mut buf = vec![0u16; (len + 1) as usize];
        let got = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
        String::from_utf16_lossy(&buf[..got as usize]).trim().to_string()
    }

    unsafe fn set_text(hwnd: HWND, text: &str) {
        let w = to_wide(text);
        SetWindowTextW(hwnd, w.as_ptr());
    }

    unsafe fn is_checked(hwnd: HWND) -> bool {
        SendMessageW(hwnd, BM_GETCHECK, 0, 0) != 0
    }

    fn default_paths() -> (PathBuf, PathBuf, PathBuf) {
        let install_dir = PathBuf::from(r"C:\Missler\mcp");
        let ipc_dir = install_dir.join(".ts6-ipc");

        let shared_tpl = PathBuf::from(r"Y:\Works\bazis\TopSolid_Templates");
        let templates_dir = if shared_tpl.exists() {
            shared_tpl
        } else {
            install_dir.join("Templates")
        };

        (install_dir, ipc_dir, templates_dir)
    }

    fn json_escape(s: &str) -> String {
        let mut out = String::with_capacity(s.len() + 8);
        for c in s.chars() {
            match c {
                '\\' => out.push_str("\\\\"),
                '"' => out.push_str("\\\""),
                '\n' => out.push_str("\\n"),
                '\r' => out.push_str("\\r"),
                '\t' => out.push_str("\\t"),
                _ => out.push(c),
            }
        }
        out
    }

    fn write_uninstall_registry(install_dir: &Path) {
        unsafe {
            let subkey = to_wide(r"Software\Microsoft\Windows\CurrentVersion\Uninstall\TopSolid6MCP");
            let mut hkey: HKEY = null_mut();
            let rc = RegCreateKeyW(HKEY_CURRENT_USER, subkey.as_ptr(), &mut hkey);
            if rc != 0 {
                return;
            }
            let set_sz = |name: &str, val: &str| {
                let wn = to_wide(name);
                let wv = to_wide(val);
                let byte_len = (wv.len() * 2) as u32;
                RegSetValueExW(hkey, wn.as_ptr(), 0, REG_SZ, wv.as_ptr() as *const u8, byte_len);
            };
            let set_dw = |name: &str, val: u32| {
                let wn = to_wide(name);
                RegSetValueExW(hkey, wn.as_ptr(), 0, REG_DWORD, &val as *const u32 as *const u8, 4);
            };

            let icon_path = install_dir.join("assets").join("ts6_mcp.ico");
            let uninst_bat = install_dir.join("Uninstall_TopSolid6_MCP.bat");
            let uninst_cmd = format!("cmd.exe /c \"{}\"", uninst_bat.display());

            set_sz("DisplayName", "TopSolid MCP Bridge");
            set_sz("DisplayVersion", APP_VERSION);
            set_sz("Publisher", "B&S CNC Automation");
            set_sz("InstallLocation", &install_dir.to_string_lossy());
            set_sz("DisplayIcon", &format!("{},0", icon_path.display()));
            set_sz("UninstallString", &uninst_cmd);
            set_sz("URLInfoAbout", "https://github.com/cebdan/bazis-mcp-scripts");
            set_dw("NoModify", 1);
            set_dw("NoRepair", 1);
            RegCloseKey(hkey);
        }
    }

    fn perform_install<F>(opts: &InstallOptions, mut on_progress: F) -> Result<String, String>
    where
        F: FnMut(i32, &str),
    {
        // 1. Stop existing bridge instances
        on_progress(8, "Stopping any running TopSolid MCP Bridge...");
        let kill_ps = "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.CommandLine -like '*ts6_bridge.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
        let _ = Command::new("powershell.exe")
            .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", kill_ps])
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();

        // 2. Extract embedded files
        on_progress(15, "Extracting TopSolid MCP Bridge files...");
        fs::create_dir_all(&opts.install_dir)
            .map_err(|e| format!("Failed to create install folder: {e}"))?;
        for (i, (rel, bytes)) in PAYLOAD.iter().enumerate() {
            let dest = opts.install_dir.join(rel.replace('/', "\\"));
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create folder {}: {e}", parent.display()))?;
            }
            fs::write(&dest, bytes)
                .map_err(|e| format!("Failed to write {}: {e}", dest.display()))?;
            let pct = 15 + ((i + 1) as i32 * 25 / PAYLOAD.len() as i32);
            on_progress(pct, &format!("Extracted {rel}"));
        }

        // 3. Ensure IPC folder & write %APPDATA%\TopSolid6MCP\config.json
        on_progress(42, "Writing configuration...");
        let _ = fs::create_dir_all(&opts.ipc_dir);
        let _ = fs::create_dir_all(&opts.templates_dir);
        if let Ok(appdata) = std::env::var("APPDATA") {
            let cfg_dir = PathBuf::from(appdata).join("TopSolid6MCP");
            let _ = fs::create_dir_all(&cfg_dir);
            let cfg_path = cfg_dir.join("config.json");
            let cfg_json = format!(
                "{{\r\n  \"ipcDir\": \"{}\",\r\n  \"templatesDir\": \"{}\",\r\n  \"topsolidExe\": \"{}\",\r\n  \"pollIntervalMs\": 120,\r\n  \"githubRepo\": \"cebdan/bazis-mcp-scripts\",\r\n  \"githubBranch\": \"main\",\r\n  \"autoCheckUpdates\": true,\r\n  \"showNotifications\": true\r\n}}\r\n",
                json_escape(&opts.ipc_dir.to_string_lossy()),
                json_escape(&opts.templates_dir.to_string_lossy()),
                json_escape(&opts.topsolid_exe)
            );
            fs::write(&cfg_path, cfg_json)
                .map_err(|e| format!("Failed to write config.json: {e}"))?;
        }

        let ps1 = opts.install_dir.join("agent").join("ts6_bridge.ps1");
        let deps_ps1 = opts.install_dir.join("agent").join("ts6_ensure_deps.ps1");
        let mut node_summary = "Skipped".to_string();
        let mut mcp_summary = "Skipped".to_string();

        // 4. Check / install Node.js LTS runtime & configure Antigravity MCP
        if opts.ensure_node || opts.configure_antigravity {
            on_progress(
                50,
                if opts.ensure_node {
                    "Checking Node.js LTS runtime (auto-installing if missing)..."
                } else {
                    "Configuring Antigravity MCP..."
                },
            );
            let mut dep_args: Vec<String> = vec![
                "-NoProfile".into(),
                "-ExecutionPolicy".into(),
                "Bypass".into(),
                "-File".into(),
                deps_ps1.to_string_lossy().into_owned(),
                "-InstallDir".into(),
                opts.install_dir.to_string_lossy().into_owned(),
            ];
            if opts.ensure_node {
                dep_args.push("-EnsureNode".into());
            }
            if opts.configure_antigravity {
                dep_args.push("-ConfigureAntigravity".into());
            }
            let out = Command::new("powershell.exe")
                .args(&dep_args)
                .creation_flags(CREATE_NO_WINDOW)
                .output()
                .map_err(|e| format!("Failed to run prerequisite installer: {e}"))?;
            let stdout = String::from_utf8_lossy(&out.stdout);
            let stderr = String::from_utf8_lossy(&out.stderr);
            if !out.status.success() {
                return Err(format!(
                    "Node.js / MCP configuration failed: {}",
                    if !stderr.trim().is_empty() { stderr.trim() } else { stdout.trim() }
                ));
            }
            for line in stdout.lines() {
                if let Some(rest) = line.strip_prefix("NODE_OK|") {
                    let parts: Vec<&str> = rest.splitn(2, '|').collect();
                    if parts.len() == 2 {
                        node_summary = format!("{} ({})", parts[0], parts[1]);
                    }
                } else if let Some(rest) = line.strip_prefix("MCP_CONFIG_OK|") {
                    mcp_summary = format!("Configured ({rest})");
                }
            }
            on_progress(72, &format!("Node.js ready: {node_summary}"));
        }

        // 4b. Build base B&S_*.top templates natively if Templates folder is missing them
        let mut tpl_summary = "Already present / Skipped".to_string();
        if opts.build_templates && !opts.templates_dir.join("B&S_Drill.top").exists() {
            on_progress(75, "Building base B&S_*.top templates in chosen TopSolid version...");
            let tpl_ps1 = opts.install_dir.join("agent").join("ts6_build_templates.ps1");
            let mut t_args: Vec<String> = vec![
                "-NoProfile".into(),
                "-ExecutionPolicy".into(),
                "Bypass".into(),
                "-File".into(),
                tpl_ps1.to_string_lossy().into_owned(),
                "-TemplatesDir".into(),
                opts.templates_dir.to_string_lossy().into_owned(),
            ];
            if !opts.topsolid_exe.is_empty() {
                t_args.push("-TopSolidExe".into());
                t_args.push(opts.topsolid_exe.clone());
            }
            if let Ok(out) = Command::new("powershell.exe")
                .args(&t_args)
                .creation_flags(CREATE_NO_WINDOW)
                .output()
            {
                let stdout = String::from_utf8_lossy(&out.stdout);
                if stdout.contains("TEMPLATES_OK|") {
                    tpl_summary = format!("Built in {}", opts.templates_dir.display());
                } else {
                    tpl_summary = "Skipped (start TopSolid and click Rebuild Templates)".to_string();
                }
            }
        }

        // 5. Install Windows autostart service (Scheduled Task)
        if opts.install_service {
            on_progress(78, "Installing Windows autostart service (Task Scheduler)...");
            let out = Command::new("powershell.exe")
                .args([
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    &ps1.to_string_lossy(),
                    "-InstallService",
                ])
                .creation_flags(CREATE_NO_WINDOW)
                .output()
                .map_err(|e| format!("Failed to run service installer: {e}"))?;
            if !out.status.success() {
                let err = String::from_utf8_lossy(&out.stderr);
                return Err(format!("Service installation failed: {}", err.trim()));
            }
        }

        // 6. Create Start Menu section
        if opts.install_start_menu {
            on_progress(85, "Creating Start Menu section ('TopSolid MCP')...");
            let out = Command::new("powershell.exe")
                .args([
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    &ps1.to_string_lossy(),
                    "-InstallStartMenu",
                ])
                .creation_flags(CREATE_NO_WINDOW)
                .output()
                .map_err(|e| format!("Failed to create Start Menu shortcuts: {e}"))?;
            if !out.status.success() {
                let err = String::from_utf8_lossy(&out.stderr);
                return Err(format!("Start Menu creation failed: {}", err.trim()));
            }
        }

        // 7. Register in Windows Installed Apps (HKCU Uninstall)
        on_progress(90, "Registering in Windows Installed Apps...");
        write_uninstall_registry(&opts.install_dir);

        // 8. Launch Tray Bridge
        if opts.launch_after {
            on_progress(94, "Starting TopSolid MCP Bridge in System Tray...");
            let vbs = opts.install_dir.join("agent").join("ts6_tray_launcher.vbs");
            let _ = Command::new("wscript.exe")
                .args(["//B", &vbs.to_string_lossy()])
                .current_dir(&opts.install_dir)
                .creation_flags(CREATE_NO_WINDOW)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn();
        }

        // 9. Smoke-test MCP server <-> Bridge if Node.js & bridge are running
        let mut verify_summary = "Skipped".to_string();
        if opts.launch_after && opts.ensure_node {
            on_progress(97, "Verifying Node.js MCP server connection to Tray Bridge...");
            if let Ok(out) = Command::new("powershell.exe")
                .args([
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    &deps_ps1.to_string_lossy(),
                    "-InstallDir",
                    &opts.install_dir.to_string_lossy(),
                    "-VerifyMcp",
                ])
                .creation_flags(CREATE_NO_WINDOW)
                .output()
            {
                let stdout = String::from_utf8_lossy(&out.stdout);
                if stdout.contains("VERIFY_OK|") {
                    verify_summary = "PASSED (MCP server <-> Tray Bridge live)".to_string();
                } else {
                    verify_summary = "Bridge starting (recheck in tray Info)".to_string();
                }
            }
        }

        on_progress(100, "Installation complete! Ready for AI agents.");
        Ok(format!(
            "TopSolid MCP Bridge v{APP_VERSION} installed successfully!\r\n\r\n\
             - Node.js runtime: {node_summary}\r\n\
             - Antigravity MCP: {mcp_summary}\r\n\
             - Base Templates: {tpl_summary}\r\n\
             - MCP self-test: {verify_summary}\r\n\
             - System Tray icon: left-click for Info, right-click for Settings\r\n\
             - Start Menu: 'TopSolid MCP'\r\n\r\n\
             Restart Antigravity (or reload MCP servers) to start using topsolid6 tools."
        ))
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
                if ptr.is_null() {
                    return DefWindowProcW(hwnd, msg, wparam, lparam);
                }
                let st = &mut *ptr;
                let id = wparam & 0xFFFF;
                if id == ID_BTN_CANCEL {
                    if !st.installing.load(Ordering::Relaxed) {
                        DestroyWindow(hwnd);
                    }
                    return 0;
                }
                if id == ID_BTN_REBUILD_TPL {
                    if st.installing.load(Ordering::Relaxed) {
                        return 0;
                    }
                    let install_dir = PathBuf::from(get_text(st.hwnd_install));
                    let tpl_dir = PathBuf::from(get_text(st.hwnd_templates));
                    let raw_ts = get_text(st.hwnd_cmb_ts);
                    let ts_exe = if raw_ts.starts_with("Auto") { String::new() } else { raw_ts };
                    let mut builder = install_dir.join("agent").join("ts6_build_templates.ps1");
                    if !builder.exists() {
                        let tmp_ps1 = std::env::temp_dir().join("ts6_build_templates.ps1");
                        let _ = fs::write(&tmp_ps1, include_bytes!("../../agent/ts6_build_templates.ps1"));
                        builder = tmp_ps1;
                    }
                    let mut args_vec: Vec<String> = vec![
                        "/C".into(),
                        "start".into(),
                        "".into(),
                        "powershell.exe".into(),
                        "-NoProfile".into(),
                        "-ExecutionPolicy".into(),
                        "Bypass".into(),
                        "-File".into(),
                        builder.to_string_lossy().into_owned(),
                        "-TemplatesDir".into(),
                        tpl_dir.to_string_lossy().into_owned(),
                        "-Force".into(),
                        "-PauseOnExit".into(),
                    ];
                    if !ts_exe.is_empty() {
                        args_vec.push("-TopSolidExe".into());
                        args_vec.push(ts_exe);
                    }
                    let _ = Command::new("cmd.exe")
                        .args(&args_vec)
                        .creation_flags(CREATE_NO_WINDOW)
                        .spawn();
                    return 0;
                }
                if id == ID_BTN_INSTALL {
                    if st.finished {
                        DestroyWindow(hwnd);
                        return 0;
                    }
                    if st.installing.swap(true, Ordering::SeqCst) {
                        return 0;
                    }
                    let raw_ts = get_text(st.hwnd_cmb_ts);
                    let ts_exe = if raw_ts.starts_with("Auto") { String::new() } else { raw_ts };
                    let opts = InstallOptions {
                        install_dir: PathBuf::from(get_text(st.hwnd_install)),
                        ipc_dir: PathBuf::from(get_text(st.hwnd_ipc)),
                        templates_dir: PathBuf::from(get_text(st.hwnd_templates)),
                        topsolid_exe: ts_exe,
                        ensure_node: is_checked(st.hwnd_chk_node),
                        configure_antigravity: is_checked(st.hwnd_chk_agy),
                        build_templates: is_checked(st.hwnd_chk_tpl),
                        install_service: is_checked(st.hwnd_chk_svc),
                        install_start_menu: is_checked(st.hwnd_chk_sm),
                        launch_after: is_checked(st.hwnd_chk_launch),
                    };
                    if opts.install_dir.as_os_str().is_empty() {
                        st.installing.store(false, Ordering::Relaxed);
                        let m = to_wide("Please specify an installation folder.");
                        let t = to_wide("TopSolid MCP Setup");
                        MessageBoxW(hwnd, m.as_ptr(), t.as_ptr(), MB_OK | MB_ICONERROR);
                        return 0;
                    }
                    EnableWindow(st.hwnd_btn_install, 0);
                    EnableWindow(st.hwnd_btn_cancel, 0);
                    EnableWindow(st.hwnd_btn_rebuild, 0);
                    EnableWindow(st.hwnd_install, 0);
                    EnableWindow(st.hwnd_ipc, 0);
                    EnableWindow(st.hwnd_templates, 0);
                    EnableWindow(st.hwnd_cmb_ts, 0);

                    let hwnd_num = hwnd as usize;
                    let flag = st.installing.clone();
                    thread::spawn(move || {
                        let res = perform_install(&opts, |pct, msg_txt| {
                            let boxed = Box::into_raw(Box::new(msg_txt.to_string())) as LPARAM;
                            PostMessageW(hwnd_num as HWND, WM_APP_PROGRESS, pct as WPARAM, boxed);
                        });
                        flag.store(false, Ordering::SeqCst);
                        match res {
                            Ok(summary) => {
                                let boxed = Box::into_raw(Box::new(summary)) as LPARAM;
                                PostMessageW(hwnd_num as HWND, WM_APP_DONE, 0, boxed);
                            }
                            Err(e) => {
                                let boxed = Box::into_raw(Box::new(e)) as LPARAM;
                                PostMessageW(hwnd_num as HWND, WM_APP_ERROR, 0, boxed);
                            }
                        }
                    });
                    return 0;
                }
            }
            WM_APP_PROGRESS => {
                if !ptr.is_null() {
                    let st = &*ptr;
                    SendMessageW(st.hwnd_progress, PBM_SETPOS, wparam, 0);
                    if lparam != 0 {
                        let s = Box::from_raw(lparam as *mut String);
                        set_text(st.hwnd_status, &s);
                    }
                }
                return 0;
            }
            WM_APP_DONE => {
                if !ptr.is_null() {
                    let st = &mut *ptr;
                    st.finished = true;
                    SendMessageW(st.hwnd_progress, PBM_SETPOS, 100, 0);
                    set_text(st.hwnd_btn_install, "Finish");
                    EnableWindow(st.hwnd_btn_install, 1);
                    EnableWindow(st.hwnd_btn_cancel, 1);
                    let summary = if lparam != 0 {
                        *Box::from_raw(lparam as *mut String)
                    } else {
                        "Installation complete!".to_string()
                    };
                    let m = to_wide(&summary);
                    let t = to_wide("Installation Complete");
                    MessageBoxW(hwnd, m.as_ptr(), t.as_ptr(), MB_OK | MB_ICONINFORMATION);
                }
                return 0;
            }
            WM_APP_ERROR => {
                if !ptr.is_null() {
                    let st = &mut *ptr;
                    EnableWindow(st.hwnd_btn_install, 1);
                    EnableWindow(st.hwnd_btn_cancel, 1);
                    EnableWindow(st.hwnd_btn_rebuild, 1);
                    EnableWindow(st.hwnd_install, 1);
                    EnableWindow(st.hwnd_ipc, 1);
                    EnableWindow(st.hwnd_templates, 1);
                    EnableWindow(st.hwnd_cmb_ts, 1);
                    let err_msg = if lparam != 0 {
                        *Box::from_raw(lparam as *mut String)
                    } else {
                        "Unknown installation error".to_string()
                    };
                    set_text(st.hwnd_status, &format!("Error: {err_msg}"));
                    let m = to_wide(&err_msg);
                    let t = to_wide("TopSolid MCP Setup - Error");
                    MessageBoxW(hwnd, m.as_ptr(), t.as_ptr(), MB_OK | MB_ICONERROR);
                }
                return 0;
            }
            WM_CLOSE => {
                if !ptr.is_null() && (*ptr).installing.load(Ordering::Relaxed) {
                    return 0;
                }
                DestroyWindow(hwnd);
                return 0;
            }
            WM_DESTROY => {
                if !ptr.is_null() {
                    let _ = Box::from_raw(ptr);
                    SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
                }
                PostQuitMessage(0);
                return 0;
            }
            _ => {}
        }
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }

    pub fn run() {
        let args: Vec<String> = std::env::args().collect();
        let silent = args
            .iter()
            .any(|a| a.eq_ignore_ascii_case("/S") || a.eq_ignore_ascii_case("--silent"));

        let (def_install, def_ipc, def_tpl) = default_paths();
        let discovered_ts = discover_topsolid_exes();
        let default_ts_exe = discovered_ts.first().cloned().unwrap_or_default();

        if silent {
            let opts = InstallOptions {
                install_dir: def_install,
                ipc_dir: def_ipc,
                templates_dir: def_tpl,
                topsolid_exe: default_ts_exe,
                ensure_node: true,
                configure_antigravity: true,
                build_templates: true,
                install_service: true,
                install_start_menu: true,
                launch_after: true,
            };
            if let Err(e) = perform_install(&opts, |_, _| {}) {
                eprintln!("{e}");
                std::process::exit(1);
            }
            return;
        }

        unsafe {
            SetProcessDPIAware();
            let icc = INITCOMMONCONTROLSEX {
                dwSize: std::mem::size_of::<INITCOMMONCONTROLSEX>() as u32,
                dwICC: ICC_PROGRESS_CLASS,
            };
            InitCommonControlsEx(&icc);

            let hdc = GetDC(null_mut());
            let dpi = if !hdc.is_null() {
                let d = GetDeviceCaps(hdc, LOGPIXELSX as i32);
                ReleaseDC(null_mut(), hdc);
                if d > 0 { d } else { 96 }
            } else {
                96
            };
            let s = |px: i32| -> i32 { (px * dpi + 48) / 96 };

            let hinst = GetModuleHandleW(null());
            let cls_name = to_wide("TopSolid6McpSetupWnd");
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

            let win_w = s(600);
            let win_h = s(565);
            let scr_w = GetSystemMetrics(SM_CXSCREEN);
            let scr_h = GetSystemMetrics(SM_CYSCREEN);
            let win_x = ((scr_w - win_w) / 2).max(0);
            let win_y = ((scr_h - win_h) / 2).max(0);

            let title = to_wide(&format!("TopSolid MCP Setup (v{APP_VERSION})"));
            let hwnd = CreateWindowExW(
                0,
                cls_name.as_ptr(),
                title.as_ptr(),
                WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX | WS_CLIPCHILDREN,
                win_x,
                win_y,
                win_w,
                win_h,
                null_mut(),
                null_mut(),
                hinst,
                null(),
            );

            // Set window icon from embedded ts6_mcp.ico
            let ico_tmp = std::env::temp_dir().join("ts6_mcp_setup.ico");
            if fs::write(&ico_tmp, include_bytes!("../../assets/ts6_mcp.ico")).is_ok() {
                let wico = to_wide(&ico_tmp.to_string_lossy());
                let hicon = LoadImageW(
                    null_mut(),
                    wico.as_ptr(),
                    IMAGE_ICON,
                    0,
                    0,
                    LR_LOADFROMFILE | LR_DEFAULTSIZE,
                );
                if !hicon.is_null() {
                    SendMessageW(hwnd, WM_SETICON, 0, hicon as LPARAM);
                    SendMessageW(hwnd, WM_SETICON, 1, hicon as LPARAM);
                }
            }

            let font_name = to_wide("Segoe UI");
            let font_norm: HFONT = CreateFontW(
                -s(14), 0, 0, 0, FW_NORMAL as i32, 0, 0, 0,
                DEFAULT_CHARSET as u32, 0, 0, 0, (DEFAULT_PITCH | FF_SWISS) as u32,
                font_name.as_ptr(),
            );
            let font_bold: HFONT = CreateFontW(
                -s(19), 0, 0, 0, FW_BOLD as i32, 0, 0, 0,
                DEFAULT_CHARSET as u32, 0, 0, 0, (DEFAULT_PITCH | FF_SWISS) as u32,
                font_name.as_ptr(),
            );

            let mk = |cls: &str, text: &str, style: u32, x: i32, y: i32, w: i32, h: i32, id: usize, f: HFONT| -> HWND {
                let wc_s = to_wide(cls);
                let wt_s = to_wide(text);
                let ctrl = CreateWindowExW(
                    0,
                    wc_s.as_ptr(),
                    wt_s.as_ptr(),
                    WS_CHILD | WS_VISIBLE | style,
                    s(x), s(y), s(w), s(h),
                    hwnd,
                    id as _,
                    hinst,
                    null(),
                );
                SendMessageW(ctrl, WM_SETFONT, f as WPARAM, 1);
                ctrl
            };

            mk("STATIC", &format!("TopSolid MCP  v{APP_VERSION}"), SS_LEFT, 20, 16, 530, 28, 0, font_bold);
            mk("STATIC", "Installs the System Tray COM bridge, Windows autostart service, Start Menu shortcuts, and GitHub updater.", SS_LEFT, 20, 48, 530, 34, 0, font_norm);

            mk("STATIC", "Install Folder:", SS_LEFT, 20, 96, 110, 22, 0, font_norm);
            let hwnd_install = mk("EDIT", &def_install.to_string_lossy(), WS_BORDER | WS_TABSTOP | (ES_AUTOHSCROLL as u32), 134, 93, 416, 26, ID_EDIT_INSTALL, font_norm);

            mk("STATIC", "IPC Folder:", SS_LEFT, 20, 130, 110, 22, 0, font_norm);
            let hwnd_ipc = mk("EDIT", &def_ipc.to_string_lossy(), WS_BORDER | WS_TABSTOP | (ES_AUTOHSCROLL as u32), 134, 127, 416, 26, ID_EDIT_IPC, font_norm);

            mk("STATIC", "Templates Dir:", SS_LEFT, 20, 164, 110, 22, 0, font_norm);
            let hwnd_templates = mk("EDIT", &def_tpl.to_string_lossy(), WS_BORDER | WS_TABSTOP | (ES_AUTOHSCROLL as u32), 134, 161, 426, 26, ID_EDIT_TEMPLATES, font_norm);

            mk("STATIC", "TopSolid Ver:", SS_LEFT, 20, 198, 110, 22, 0, font_norm);
            let hwnd_cmb_ts = mk("COMBOBOX", "", CBS_DROPDOWN | CBS_AUTOHSCROLL | WS_VSCROLL | WS_TABSTOP, 134, 195, 426, 180, ID_CMB_TOPSOLID, font_norm);
            let auto_item = to_wide("Auto (Active COM / Newest)");
            SendMessageW(hwnd_cmb_ts, CB_ADDSTRING, 0, auto_item.as_ptr() as LPARAM);
            for exe_p in &discovered_ts {
                let wp = to_wide(exe_p);
                SendMessageW(hwnd_cmb_ts, CB_ADDSTRING, 0, wp.as_ptr() as LPARAM);
            }
            SendMessageW(hwnd_cmb_ts, CB_SETCURSEL, if discovered_ts.is_empty() { 0 } else { 1 }, 0);

            let hwnd_chk_node = mk("BUTTON", "Check & auto-install Node.js LTS runtime if missing (required for MCP)", (BS_AUTOCHECKBOX as u32) | WS_TABSTOP, 20, 236, 540, 24, ID_CHK_NODE, font_norm);
            let hwnd_chk_agy = mk("BUTTON", "Auto-configure Antigravity MCP (mcp_config.json)", (BS_AUTOCHECKBOX as u32) | WS_TABSTOP, 20, 264, 540, 24, ID_CHK_AGY, font_norm);
            let hwnd_chk_tpl = mk("BUTTON", "Build base B&&S_*.top templates in chosen TopSolid if folder is empty", (BS_AUTOCHECKBOX as u32) | WS_TABSTOP, 20, 292, 540, 24, ID_CHK_TEMPLATES, font_norm);
            let hwnd_chk_svc = mk("BUTTON", "Install as Windows Service (Autostart at logon via Task Scheduler)", (BS_AUTOCHECKBOX as u32) | WS_TABSTOP, 20, 320, 540, 24, ID_CHK_SERVICE, font_norm);
            let hwnd_chk_sm = mk("BUTTON", "Create Start Menu section (\"TopSolid MCP\")", (BS_AUTOCHECKBOX as u32) | WS_TABSTOP, 20, 348, 540, 24, ID_CHK_STARTMENU, font_norm);
            let hwnd_chk_launch = mk("BUTTON", "Launch TopSolid MCP Bridge in System Tray & run MCP self-test", (BS_AUTOCHECKBOX as u32) | WS_TABSTOP, 20, 376, 540, 24, ID_CHK_LAUNCH, font_norm);
            SendMessageW(hwnd_chk_node, BM_SETCHECK, 1, 0);
            SendMessageW(hwnd_chk_agy, BM_SETCHECK, 1, 0);
            SendMessageW(hwnd_chk_tpl, BM_SETCHECK, 1, 0);
            SendMessageW(hwnd_chk_svc, BM_SETCHECK, 1, 0);
            SendMessageW(hwnd_chk_sm, BM_SETCHECK, 1, 0);
            SendMessageW(hwnd_chk_launch, BM_SETCHECK, 1, 0);

            let hwnd_progress = mk("msctls_progress32", "", 0, 20, 414, 540, 22, 0, font_norm);
            SendMessageW(hwnd_progress, PBM_SETRANGE32, 0, 100);

            let hwnd_status = mk("STATIC", "Ready to install.", SS_LEFT, 20, 444, 540, 22, 0, font_norm);

            let hwnd_btn_rebuild = mk("BUTTON", "Rebuild Templates...", (BS_PUSHBUTTON as u32) | WS_TABSTOP, 20, 478, 175, 32, ID_BTN_REBUILD_TPL, font_norm);
            let hwnd_btn_install = mk("BUTTON", "Install", (BS_DEFPUSHBUTTON as u32) | WS_TABSTOP, 344, 478, 106, 32, ID_BTN_INSTALL, font_norm);
            let hwnd_btn_cancel = mk("BUTTON", "Cancel", (BS_PUSHBUTTON as u32) | WS_TABSTOP, 458, 478, 102, 32, ID_BTN_CANCEL, font_norm);

            let st = Box::new(UiState {
                hwnd_install,
                hwnd_ipc,
                hwnd_templates,
                hwnd_cmb_ts,
                hwnd_chk_node,
                hwnd_chk_agy,
                hwnd_chk_tpl,
                hwnd_chk_svc,
                hwnd_chk_sm,
                hwnd_chk_launch,
                hwnd_btn_rebuild,
                hwnd_btn_install,
                hwnd_btn_cancel,
                hwnd_progress,
                hwnd_status,
                installing: Arc::new(AtomicBool::new(false)),
                finished: false,
            });
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, Box::into_raw(st) as isize);

            ShowWindow(hwnd, SW_SHOW);

            let mut msg: MSG = std::mem::zeroed();
            while GetMessageW(&mut msg, null_mut(), 0, 0) > 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
    }
}
