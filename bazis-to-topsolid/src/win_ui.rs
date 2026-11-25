#![cfg(windows)]

use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::sleep;
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM, RECT};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    keybd_event, mouse_event, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT,
    KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumChildWindows, EnumWindows, GetClassNameW, GetWindowRect, GetWindowTextLengthW,
    GetWindowTextW, IsWindowVisible, SetCursorPos, SetForegroundWindow, SetProcessDPIAware,
    ShowWindow, SW_MAXIMIZE,
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
    let title = get_window_text(hwnd);
    if title.contains("TopSolid") {
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
        if GetWindowRect(hwnd, &mut r) != 0 && r.top >= 150 && r.top <= 360 {
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
        if GetWindowRect(hwnd, &mut r) != 0 && r.top >= 150 && r.top <= 360 && r.right > r.left + 8 {
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
        if GetWindowRect(hwnd, &mut r) != 0 && r.top >= 150 && r.top <= 360 && r.right > r.left + 8 {
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
    let mut done = 0usize;
    for (cmp, panel) in pairs {
        if cancel.load(Ordering::Relaxed) {
            tap_vk(0x1B);
            return Err(format!("Stopped by user after {}/{} operations.", done, total));
        }

        // Step 0: Guarantee TopSolid is at "Component to use:" (retry up to 3x on heavy scenes)
        let mut at_comp_prompt = get_prompt_bar_text(hwnd)
            .to_ascii_lowercase()
            .contains("component to use");
        for _attempt in 0..3 {
            if at_comp_prompt {
                break;
            }
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
            done += 1;
            on_progress(done, total, &format!("Skipped (Use process menu timeout): {} -> {}", cmp, panel));
            continue;
        }

        // Step 1: Focus the prompt [Edit] box explicitly (heavy scenes steal focus during redraw),
        // clear any leftover text, type component name, press ENTER, and wait for [PROCESS=...] button.
        focus_prompt_edit(hwnd);
        clear_input();
        type_unicode(cmp);
        tap_vk(0x0D);

        let proc_btn = wait_prompt_button(hwnd, "process=", false, 1800);
        let Some((px, py)) = proc_btn else {
            tap_vk(0x1B);
            sleep(Duration::from_millis(80));
            done += 1;
            on_progress(done, total, &format!("Skipped (PROCESS button not found): {} -> {}", cmp, panel));
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
            tap_vk(0x1B);
            sleep(Duration::from_millis(80));
            done += 1;
            on_progress(done, total, &format!("Skipped (Shape prompt not reached): {} -> {}", cmp, panel));
            continue;
        }

        // Step 3: Focus prompt [Edit] box, type target panel name + ENTER, wait for [OK] button
        focus_prompt_edit(hwnd);
        clear_input();
        type_unicode(panel);
        tap_vk(0x0D);

        // Step 4: Click [OK] button (or press ENTER) to execute the native TopSolid'Wood operation
        if let Some((ox, oy)) = wait_prompt_button(hwnd, "ok", true, 1500) {
            click(ox, oy);
        } else {
            tap_vk(0x0D);
        }

        // Wait dynamically until TopSolid finishes Parasolid operation & returns to "Component to use:"
        wait_prompt_bar_contains_any(hwnd, &["component to use", "choose a function"], 4000);
        sleep(Duration::from_millis(20));

        done += 1;
        on_progress(done, total, &format!("Use process: {} -> {}", cmp, panel));
    }

    tap_vk(0x1B);
    sleep(Duration::from_millis(80));
    Ok(done)
}
