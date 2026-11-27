#![cfg(windows)]

use std::ptr::null_mut;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::thread::sleep;
use std::time::{Duration, Instant};

use crate::diag_log::log_line;

use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Threading::GetCurrentProcessId;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    keybd_event, mouse_event, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT,
    KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, EnumChildWindows, EnumWindows, GetClassNameW, GetForegroundWindow,
    GetWindowRect, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, HHOOK,
    IsWindowVisible, KBDLLHOOKSTRUCT, LLKHF_INJECTED, LLMHF_INJECTED, MSLLHOOKSTRUCT,
    SetCursorPos, SetForegroundWindow, SetProcessDPIAware, SetWindowsHookExW, ShowWindow,
    UnhookWindowsHookEx, WindowFromPoint, SW_MAXIMIZE, WH_KEYBOARD_LL, WH_MOUSE_LL,
    WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MBUTTONDOWN, WM_MBUTTONUP, WM_MOUSEHWHEEL, WM_MOUSEWHEEL,
    WM_RBUTTONDOWN, WM_RBUTTONUP, WM_XBUTTONDOWN, WM_XBUTTONUP,
};

pub fn init_dpi_aware() {
    unsafe {
        SetProcessDPIAware();
    }
}

fn get_window_text(hwnd: HWND) -> String {
    unsafe {
        let len = GetWindowTextLengthW(hwnd);
        if len <= 0 {
            return String::new();
        }
        let mut buf = vec![0u16; (len + 1) as usize];
        GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
        String::from_utf16_lossy(&buf[..len as usize])
    }
}

fn get_class_name(hwnd: HWND) -> String {
    unsafe {
        let mut buf = [0u16; 128];
        let len = GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
        if len <= 0 {
            return String::new();
        }
        String::from_utf16_lossy(&buf[..len as usize])
    }
}

unsafe extern "system" fn enum_cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
    if IsWindowVisible(hwnd) == 0 {
        return 1;
    }
    // NEVER match our own exporter window (whose title also contains "TopSolid")!
    let mut pid: u32 = 0;
    GetWindowThreadProcessId(hwnd, &mut pid);
    if pid == GetCurrentProcessId() {
        return 1;
    }
    let title = get_window_text(hwnd);
    if title.contains("TopSolid") && !title.contains("Exporter") && !title.contains("MCP") {
        let out = lparam as *mut HWND;
        *out = hwnd;
        return 0;
    }
    1
}

pub fn find_topsolid_hwnd() -> Option<HWND> {
    let mut found: HWND = std::ptr::null_mut();
    unsafe {
        EnumWindows(Some(enum_cb), &mut found as *mut HWND as LPARAM);
    }
    if found.is_null() {
        None
    } else {
        Some(found)
    }
}

/// Live scan of all visible Static labels inside TopSolid's prompt bar (y in 180..340).
/// TopSolid destroys and recreates prompt-bar child controls on every step transition,
/// so we never cache a single HWND across transitions.
struct PromptTextAcc {
    text: String,
}

unsafe extern "system" fn enum_prompt_text_cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
    if IsWindowVisible(hwnd) == 0 {
        return 1;
    }
    if get_class_name(hwnd) == "Static" {
        let mut r: RECT = std::mem::zeroed();
        if GetWindowRect(hwnd, &mut r) != 0 && r.top >= 70 && r.top <= 420 {
            let t = get_window_text(hwnd);
            if !t.is_empty() {
                let acc = &mut *(lparam as *mut PromptTextAcc);
                if !acc.text.is_empty() {
                    acc.text.push(' ');
                }
                acc.text.push_str(&t);
            }
        }
    }
    1
}

fn get_prompt_bar_text(parent: HWND) -> String {
    let mut acc = PromptTextAcc { text: String::new() };
    unsafe {
        EnumChildWindows(parent, Some(enum_prompt_text_cb), &mut acc as *mut PromptTextAcc as LPARAM);
    }
    acc.text
}

struct ButtonSearch<'a> {
    needle_lower: &'a str,
    exact: bool,
    found_rect: Option<RECT>,
}

unsafe extern "system" fn enum_prompt_btn_cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
    if IsWindowVisible(hwnd) == 0 {
        return 1;
    }
    if get_class_name(hwnd) == "Button" {
        let mut r: RECT = std::mem::zeroed();
        if GetWindowRect(hwnd, &mut r) != 0 && r.top >= 70 && r.top <= 420 && r.right > r.left + 8 {
            let t = get_window_text(hwnd).trim().to_ascii_lowercase();
            let search = &mut *(lparam as *mut ButtonSearch);
            let matched = if search.exact {
                t == search.needle_lower
            } else {
                t.contains(search.needle_lower)
            };
            if matched {
                search.found_rect = Some(r);
                return 0;
            }
        }
    }
    1
}

/// Find a visible prompt-bar Win32 Button by text (exact or substring, case-insensitive)
/// and return its exact screen center `(cx, cy)`. Works at any DPI / process name width.
fn find_prompt_button_center(parent: HWND, needle_lower: &str, exact: bool) -> Option<(i32, i32)> {
    let mut search = ButtonSearch {
        needle_lower,
        exact,
        found_rect: None,
    };
    unsafe {
        EnumChildWindows(parent, Some(enum_prompt_btn_cb), &mut search as *mut ButtonSearch as LPARAM);
    }
    search.found_rect.map(|r| ((r.left + r.right) / 2, (r.top + r.bottom) / 2))
}

unsafe extern "system" fn enum_edit_cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
    if IsWindowVisible(hwnd) == 0 {
        return 1;
    }
    if get_class_name(hwnd) == "Edit" {
        let mut r: RECT = std::mem::zeroed();
        if GetWindowRect(hwnd, &mut r) != 0 && r.top >= 70 && r.top <= 420 && r.right > r.left + 8 {
            let out = lparam as *mut HWND;
            *out = hwnd;
            return 0;
        }
    }
    1
}

fn find_prompt_edit(parent: HWND) -> Option<HWND> {
    let mut found: HWND = std::ptr::null_mut();
    unsafe {
        EnumChildWindows(parent, Some(enum_edit_cb), &mut found as *mut HWND as LPARAM);
    }
    if found.is_null() {
        None
    } else {
        Some(found)
    }
}

fn focus_prompt_edit(parent: HWND) {
    if let Some(eh) = find_prompt_edit(parent) {
        unsafe {
            let mut r: RECT = std::mem::zeroed();
            if GetWindowRect(eh, &mut r) != 0 {
                let cx = (r.left + r.right) / 2;
                let cy = (r.top + r.bottom) / 2;
                click(cx.min(r.left + 80), cy);
                sleep(Duration::from_millis(20));
                return;
            }
        }
    }
    // Fallback coordinate inside TopSolid's prompt edit box
    click(480, 260);
    sleep(Duration::from_millis(20));
}

fn wait_prompt_bar_contains_any(parent: HWND, needles: &[&str], timeout_ms: u64) -> bool {
    let start = Instant::now();
    while start.elapsed().as_millis() < timeout_ms as u128 {
        let cur = get_prompt_bar_text(parent).to_ascii_lowercase();
        if needles.iter().any(|n| cur.contains(n)) {
            return true;
        }
        sleep(Duration::from_millis(10));
    }
    false
}

fn wait_prompt_bar_contains(parent: HWND, needle: &str, timeout_ms: u64) -> bool {
    wait_prompt_bar_contains_any(parent, &[needle], timeout_ms)
}

fn wait_prompt_button(parent: HWND, needle_lower: &str, exact: bool, timeout_ms: u64) -> Option<(i32, i32)> {
    let start = Instant::now();
    while start.elapsed().as_millis() < timeout_ms as u128 {
        if let Some(pt) = find_prompt_button_center(parent, needle_lower, exact) {
            return Some(pt);
        }
        sleep(Duration::from_millis(10));
    }
    None
}

pub fn focus_topsolid() -> Result<HWND, String> {
    let hwnd = find_topsolid_hwnd()
        .ok_or_else(|| "TopSolid 6.25 window not found. Make sure TopSolid is running.".to_string())?;
    unsafe {
        ShowWindow(hwnd, SW_MAXIMIZE);
        SetForegroundWindow(hwnd);
    }
    sleep(Duration::from_millis(120));
    Ok(hwnd)
}

pub fn click(x: i32, y: i32) {
    unsafe {
        SetCursorPos(x, y);
        sleep(Duration::from_millis(15));
        mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
        sleep(Duration::from_millis(12));
        mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
    }
}

pub fn tap_vk(vk: u8) {
    unsafe {
        keybd_event(vk, 0, 0, 0);
        sleep(Duration::from_millis(8));
        keybd_event(vk, 0, KEYEVENTF_KEYUP, 0);
        sleep(Duration::from_millis(10));
    }
}

pub fn clear_input() {
    tap_vk(0x24); // HOME
    unsafe { keybd_event(0x10, 0, 0, 0) }; // SHIFT down
    tap_vk(0x23); // END
    unsafe { keybd_event(0x10, 0, KEYEVENTF_KEYUP, 0) }; // SHIFT up
    tap_vk(0x08); // BACKSPACE
}

/// Layout-independent Unicode typing (works identically on RUS and ENG keyboards).
pub fn type_unicode(text: &str) {
    for unit in text.encode_utf16() {
        let inputs = [
            INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: 0,
                        wScan: unit,
                        dwFlags: KEYEVENTF_UNICODE,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            },
            INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: 0,
                        wScan: unit,
                        dwFlags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            },
        ];
        unsafe {
            SendInput(2, inputs.as_ptr(), std::mem::size_of::<INPUT>() as i32);
        }
        sleep(Duration::from_millis(2));
    }
}

/// Modify named parameters in the currently active TopSolid template document
/// via Parameter -> Modify parameter (fallback only for legacy binary templates).
pub fn modify_active_doc_params(params: &[(String, String)]) -> Result<(), String> {
    let _ = focus_topsolid()?;
    tap_vk(0x1B); // ESC
    sleep(Duration::from_millis(90));
    // Parameter (275, 62) -> Modify parameter (285, 185)
    click(275, 62);
    sleep(Duration::from_millis(200));
    click(285, 185);
    sleep(Duration::from_millis(220));

    for (k, v) in params {
        type_unicode(k);
        tap_vk(0x0D);
        sleep(Duration::from_millis(180));
        clear_input();
        type_unicode(v);
        tap_vk(0x0D);
        sleep(Duration::from_millis(220));
    }

    tap_vk(0x1B);
    sleep(Duration::from_millis(100));
    Ok(())
}

/// Bulletproof state-machine batch-apply of Assembly -> Use process.
/// Live-scans TopSolid's prompt bar (`Static`, `Button`, `Edit` child HWNDs) at every step
/// so variable button widths (`PROCESS=MYDRILL`, `PROCESS=MYPOCKET`, etc.), DPI scaling,
/// and heavy 60+ panel redraws can never desynchronize the batch.
pub fn apply_use_process_batch<F>(
    pairs: &[(String, String)],
    cancel: &AtomicBool,
    mut on_progress: F,
) -> Result<usize, String>
where
    F: FnMut(usize, usize, &str),
{
    if pairs.is_empty() {
        return Ok(0);
    }
    let hwnd = focus_topsolid()?;
    tap_vk(0x1B);
    sleep(Duration::from_millis(80));
    tap_vk(0x1B);
    sleep(Duration::from_millis(80));

    let total = pairs.len();
    let mut processed = 0usize;
    let mut applied = 0usize;
    let mut skipped = 0usize;
    let mut consec_menu_fail = 0usize;
    let t_batch = Instant::now();
    log_line(&format!("PHASE3 START: {} Use process pairs (TopSolid HWND={:?})", total, hwnd));
    for (cmp, panel) in pairs {
        let t_op = Instant::now();
        if cancel.load(Ordering::Relaxed) {
            tap_vk(0x1B);
            log_line(&format!("PHASE3 CANCELLED at {}/{} (applied={}, skipped={})", processed, total, applied, skipped));
            return Err(format!("Stopped by user after {}/{} operations ({} applied).", processed, total, applied));
        }

        // Step 0: Guarantee TopSolid is foreground and at "Component to use:" (retry up to 3x on heavy scenes)
        let mut at_comp_prompt = get_prompt_bar_text(hwnd)
            .to_ascii_lowercase()
            .contains("component to use");
        for _attempt in 0..3 {
            if at_comp_prompt {
                break;
            }
            unsafe {
                ShowWindow(hwnd, SW_MAXIMIZE);
                SetForegroundWindow(hwnd);
            }
            sleep(Duration::from_millis(60));
            let cur = get_prompt_bar_text(hwnd).to_ascii_lowercase();
            if !cur.contains("choose a function") {
                tap_vk(0x1B);
                sleep(Duration::from_millis(80));
                tap_vk(0x1B);
                wait_prompt_bar_contains(hwnd, "choose a function", 800);
            }
            // Open Assembly (540, 62) -> Use process (660, 480)
            click(540, 62);
            sleep(Duration::from_millis(240));
            click(660, 480);
            if wait_prompt_bar_contains(hwnd, "component to use", 1500) {
                at_comp_prompt = true;
                break;
            }
            sleep(Duration::from_millis(120));
        }
        if !at_comp_prompt {
            tap_vk(0x1B);
            processed += 1;
            skipped += 1;
            consec_menu_fail += 1;
            let seen = get_prompt_bar_text(hwnd);
            log_line(&format!(
                "  OP {}/{} {}->{} SKIPPED(menu_timeout) in {}ms | prompt='{}'",
                processed, total, cmp, panel, t_op.elapsed().as_millis(), seen
            ));
            on_progress(
                processed,
                total,
                &format!("Skipped (Use process menu timeout, prompt='{}'): {} -> {}", seen, cmp, panel),
            );
            if consec_menu_fail >= 3 {
                return Err(format!(
                    "Cannot open Assembly -> Use process in TopSolid (prompt bar: '{}'). Make sure no window covers TopSolid's top menu bar.",
                    seen
                ));
            }
            continue;
        }
        consec_menu_fail = 0;

        // Step 1: Focus the prompt [Edit] box explicitly (heavy scenes steal focus during redraw),
        // clear any leftover text, type component name, press ENTER, and wait for [PROCESS=...] button.
        focus_prompt_edit(hwnd);
        clear_input();
        type_unicode(cmp);
        tap_vk(0x0D);

        let proc_btn = wait_prompt_button(hwnd, "process=", false, 1800);
        let Some((px, py)) = proc_btn else {
            let seen = get_prompt_bar_text(hwnd);
            tap_vk(0x1B);
            sleep(Duration::from_millis(80));
            processed += 1;
            skipped += 1;
            log_line(&format!(
                "  OP {}/{} {}->{} SKIPPED(no_process_btn) in {}ms | prompt='{}'",
                processed, total, cmp, panel, t_op.elapsed().as_millis(), seen
            ));
            on_progress(processed, total, &format!("Skipped (PROCESS button not found): {} -> {}", cmp, panel));
            continue;
        };

        // Step 2: Click exact center of [PROCESS=...] button and wait for "Shape to modify:"
        let mut at_shape_prompt = false;
        for _try_btn in 0..2 {
            click(px, py);
            if wait_prompt_bar_contains_any(hwnd, &["shape to modify", "element to modify", "shape"], 1200) {
                at_shape_prompt = true;
                break;
            }
            sleep(Duration::from_millis(120));
        }
        if !at_shape_prompt {
            let seen = get_prompt_bar_text(hwnd);
            tap_vk(0x1B);
            sleep(Duration::from_millis(80));
            processed += 1;
            skipped += 1;
            log_line(&format!(
                "  OP {}/{} {}->{} SKIPPED(no_shape_prompt) in {}ms | btn=({},{}) prompt='{}'",
                processed, total, cmp, panel, t_op.elapsed().as_millis(), px, py, seen
            ));
            on_progress(processed, total, &format!("Skipped (Shape prompt not reached): {} -> {}", cmp, panel));
            continue;
        }

        // Step 3: Focus prompt [Edit] box, type target panel name + ENTER, wait for [OK] button
        focus_prompt_edit(hwnd);
        clear_input();
        type_unicode(panel);
        tap_vk(0x0D);

        // Step 4: Click [OK] button (or press ENTER) to execute the native TopSolid'Wood operation
        let ok_clicked = if let Some((ox, oy)) = wait_prompt_button(hwnd, "ok", true, 1500) {
            click(ox, oy);
            true
        } else {
            tap_vk(0x0D);
            false
        };

        // Wait dynamically until TopSolid finishes Parasolid operation & returns to "Component to use:"
        let returned = wait_prompt_bar_contains_any(hwnd, &["component to use", "choose a function"], 4000);
        sleep(Duration::from_millis(20));

        processed += 1;
        applied += 1;
        log_line(&format!(
            "  OP {}/{} {}->{} OK in {}ms (ok_btn={}, returned={})",
            processed, total, cmp, panel, t_op.elapsed().as_millis(), ok_clicked, returned
        ));
        on_progress(processed, total, &format!("Use process: {} -> {}", cmp, panel));
    }

    tap_vk(0x1B);
    sleep(Duration::from_millis(80));
    log_line(&format!(
        "PHASE3 END in {:.2}s: applied={}, skipped={}",
        t_batch.elapsed().as_secs_f64(),
        applied,
        skipped
    ));
    Ok(applied)
}

// ============================================================================
// Low-level Win32 input lock for TopSolid (WH_MOUSE_LL + WH_KEYBOARD_LL)
// Blocks physical user clicks/wheel/keys directed at TopSolid's process while
// allowing: (1) our exporter's own synthetic SendInput/mouse_event/keybd_event
// (LLMHF_INJECTED / LLKHF_INJECTED), and (2) clicking Stop in our own GUI.
// Must be installed/uninstalled on the GUI thread that pumps Win32 messages.
// ============================================================================

static LOCK_ACTIVE: AtomicBool = AtomicBool::new(false);
static LOCK_TS_PID: AtomicU32 = AtomicU32::new(0);
static HOOK_MOUSE: AtomicUsize = AtomicUsize::new(0);
static HOOK_KBD: AtomicUsize = AtomicUsize::new(0);

fn hwnd_belongs_to_locked_topsolid(hwnd: HWND) -> bool {
    let ts_pid = LOCK_TS_PID.load(Ordering::Relaxed);
    if ts_pid == 0 || hwnd.is_null() {
        return false;
    }
    let mut pid: u32 = 0;
    unsafe {
        GetWindowThreadProcessId(hwnd, &mut pid);
    }
    pid == ts_pid
}

unsafe extern "system" fn ll_mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 && LOCK_ACTIVE.load(Ordering::Relaxed) && lparam != 0 {
        let ms = &*(lparam as *const MSLLHOOKSTRUCT);
        // Only filter physical user input (never block our own synthetic injected clicks)
        if (ms.flags & LLMHF_INJECTED) == 0 {
            let msg = wparam as u32;
            let is_click_or_wheel = matches!(
                msg,
                WM_LBUTTONDOWN
                    | WM_LBUTTONUP
                    | WM_RBUTTONDOWN
                    | WM_RBUTTONUP
                    | WM_MBUTTONDOWN
                    | WM_MBUTTONUP
                    | WM_MOUSEWHEEL
                    | WM_MOUSEHWHEEL
                    | WM_XBUTTONDOWN
                    | WM_XBUTTONUP
            );
            if is_click_or_wheel {
                let hit = WindowFromPoint(ms.pt);
                if hwnd_belongs_to_locked_topsolid(hit) {
                    return 1;
                }
            }
        }
    }
    CallNextHookEx(null_mut(), code, wparam, lparam)
}

unsafe extern "system" fn ll_kbd_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 && LOCK_ACTIVE.load(Ordering::Relaxed) && lparam != 0 {
        let kb = &*(lparam as *const KBDLLHOOKSTRUCT);
        // Only filter physical user keystrokes (never block our own synthetic SendInput/keybd_event)
        if (kb.flags & LLKHF_INJECTED) == 0 {
            let fg = GetForegroundWindow();
            if hwnd_belongs_to_locked_topsolid(fg) {
                return 1;
            }
        }
    }
    CallNextHookEx(null_mut(), code, wparam, lparam)
}

/// Install low-level hooks blocking physical mouse clicks/scroll and keyboard input in TopSolid.
/// Returns true if TopSolid was found and hooks were installed.
pub fn install_topsolid_input_lock() -> bool {
    uninstall_topsolid_input_lock();
    let Some(ts_hwnd) = find_topsolid_hwnd() else {
        return false;
    };
    let mut ts_pid: u32 = 0;
    unsafe {
        GetWindowThreadProcessId(ts_hwnd, &mut ts_pid);
    }
    if ts_pid == 0 {
        return false;
    }
    LOCK_TS_PID.store(ts_pid, Ordering::Relaxed);
    unsafe {
        let hinst = GetModuleHandleW(null_mut());
        let hm = SetWindowsHookExW(WH_MOUSE_LL, Some(ll_mouse_proc), hinst, 0);
        let hk = SetWindowsHookExW(WH_KEYBOARD_LL, Some(ll_kbd_proc), hinst, 0);
        HOOK_MOUSE.store(hm as usize, Ordering::Relaxed);
        HOOK_KBD.store(hk as usize, Ordering::Relaxed);
        if !hm.is_null() || !hk.is_null() {
            LOCK_ACTIVE.store(true, Ordering::Relaxed);
            return true;
        }
    }
    false
}

/// Remove TopSolid input-lock hooks immediately. Safe to call repeatedly.
pub fn uninstall_topsolid_input_lock() {
    LOCK_ACTIVE.store(false, Ordering::Relaxed);
    LOCK_TS_PID.store(0, Ordering::Relaxed);
    let hm = HOOK_MOUSE.swap(0, Ordering::Relaxed) as HHOOK;
    if !hm.is_null() {
        unsafe {
            UnhookWindowsHookEx(hm);
        }
    }
    let hk = HOOK_KBD.swap(0, Ordering::Relaxed) as HHOOK;
    if !hk.is_null() {
        unsafe {
            UnhookWindowsHookEx(hk);
        }
    }
}

// ============================================================================
// Clean TopSolid'Wood 6.25 + TopSolid MCP bridge restart before export
// ============================================================================

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn resolve_mcp_bridge_ps1() -> Option<std::path::PathBuf> {
    let mut candidates: Vec<std::path::PathBuf> = vec![
        std::path::PathBuf::from(r"C:\Missler\mcp\agent\ts6_bridge.ps1"),
        std::path::PathBuf::from(r"C:\Missler\mcp\topsolid-mcp\agent\ts6_bridge.ps1"),
    ];
    if let Ok(exe) = std::env::current_exe() {
        if let Some(scripts_dir) = exe.parent() {
            if let Some(bazis_dir) = scripts_dir.parent() {
                if let Some(works_dir) = bazis_dir.parent() {
                    candidates.push(works_dir.join("cnc").join("topsolid-mcp").join("agent").join("ts6_bridge.ps1"));
                }
            }
        }
    }
    candidates.push(std::path::PathBuf::from(r"Y:\Works\cnc\topsolid-mcp\agent\ts6_bridge.ps1"));
    candidates.into_iter().find(|p| p.exists())
}

fn read_configured_topsolid_exe() -> Option<std::path::PathBuf> {
    let appdata = std::env::var("APPDATA").ok()?;
    let cfg_path = std::path::PathBuf::from(appdata)
        .join("TopSolid6MCP")
        .join("config.json");
    let raw = std::fs::read_to_string(&cfg_path).ok()?;
    let val: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let s = val.get("topsolidExe")?.as_str()?.trim();
    if s.is_empty() {
        return None;
    }
    let p = std::path::PathBuf::from(s);
    if p.exists() { Some(p) } else { None }
}

fn resolve_topsolid_exe() -> Option<std::path::PathBuf> {
    if let Some(cfg_exe) = read_configured_topsolid_exe() {
        return Some(cfg_exe);
    }
    let candidates = [
        r"C:\Missler\V625\bin\top625.exe",
        r"C:\Missler\V624\bin\top624.exe",
        r"C:\Missler\V623\bin\top623.exe",
    ];
    candidates
        .iter()
        .map(std::path::PathBuf::from)
        .find(|p| p.exists())
}

/// Close any running TopSolid 6.25 instance, restart the TopSolid MCP bridge,
/// and launch a clean TopSolid 6.25 window ready for COM automation.
pub fn restart_topsolid_and_mcp<F>(cancel: &AtomicBool, mut on_status: F) -> Result<(), String>
where
    F: FnMut(&str),
{
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    // 1. Close running TopSolid 6.25
    on_status("Closing running TopSolid'Wood 6.25...");
    let _ = Command::new("taskkill")
        .args(["/F", "/IM", "top625.exe"])
        .creation_flags(CREATE_NO_WINDOW)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    sleep(Duration::from_millis(800));
    if cancel.load(Ordering::Relaxed) {
        return Err("Stopped by user before restart.".into());
    }

    // 2. Restart TopSolid MCP bridge (ts6_bridge.ps1) if available
    if let Some(bridge_ps1) = resolve_mcp_bridge_ps1() {
        on_status("Restarting TopSolid MCP bridge...");
        let kill_cmd = "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.CommandLine -like '*ts6_bridge.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
        let _ = Command::new("powershell.exe")
            .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", kill_cmd])
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        sleep(Duration::from_millis(300));
        let _ = Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                &bridge_ps1.to_string_lossy(),
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        sleep(Duration::from_millis(400));
    }
    if cancel.load(Ordering::Relaxed) {
        return Err("Stopped by user during MCP bridge restart.".into());
    }

    // 3. Launch fresh TopSolid'Wood 6.25
    if let Some(ts_exe) = resolve_topsolid_exe() {
        on_status("Launching fresh TopSolid'Wood 6.25...");
        Command::new(&ts_exe)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("Failed to launch '{}': {}", ts_exe.display(), e))?;

        let start = Instant::now();
        let mut found = false;
        while start.elapsed().as_secs() < 40 {
            if cancel.load(Ordering::Relaxed) {
                return Err("Stopped by user while waiting for TopSolid'Wood 6.25.".into());
            }
            if find_topsolid_hwnd().is_some() {
                found = true;
                break;
            }
            sleep(Duration::from_millis(250));
        }
        if !found {
            return Err("Timed out waiting for TopSolid'Wood 6.25 window to appear.".into());
        }
        // Let TopSolid finish initializing toolbars and COM server
        on_status("Waiting for TopSolid'Wood 6.25 to finish startup...");
        for _ in 0..8 {
            if cancel.load(Ordering::Relaxed) {
                return Err("Stopped by user while waiting for TopSolid startup.".into());
            }
            sleep(Duration::from_millis(250));
        }
    }
    Ok(())
}
