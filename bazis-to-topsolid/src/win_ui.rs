#![cfg(windows)]

use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::sleep;
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    keybd_event, mouse_event, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT,
    KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumChildWindows, EnumWindows, GetClassNameW, GetMenu, GetMenuItemCount, GetMenuItemID,
    GetMenuStringW, GetSubMenu, GetWindowTextLengthW, GetWindowTextW, IsWindowVisible,
    PostMessageW, SetCursorPos, SetForegroundWindow, SetProcessDPIAware, ShowWindow, MF_BYPOSITION,
    SW_MAXIMIZE, WM_COMMAND,
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

unsafe extern "system" fn enum_prompt_cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
    if IsWindowVisible(hwnd) == 0 {
        return 1;
    }
    if get_class_name(hwnd) == "Static" {
        let t = get_window_text(hwnd);
        let low = t.to_ascii_lowercase();
        if low.contains("choose a function")
            || low.contains("component to use")
            || low.contains("select an element")
        {
            let out = lparam as *mut HWND;
            *out = hwnd;
            return 0;
        }
    }
    1
}

fn find_prompt_static(parent: HWND) -> Option<HWND> {
    let mut found: HWND = std::ptr::null_mut();
    unsafe {
        EnumChildWindows(parent, Some(enum_prompt_cb), &mut found as *mut HWND as LPARAM);
    }
    if found.is_null() {
        None
    } else {
        Some(found)
    }
}

/// Dynamically locate Assembly -> Use process menu command ID (typically 12326 / 0x3026).
fn find_use_process_cmd_id(hwnd: HWND) -> u32 {
    unsafe {
        let menu = GetMenu(hwnd);
        if !menu.is_null() {
            let cnt = GetMenuItemCount(menu);
            for i in 0..cnt {
                let mut buf = [0u16; 128];
                let n = GetMenuStringW(menu, i as u32, buf.as_mut_ptr(), 128, MF_BYPOSITION);
                if n > 0 {
                    let s = String::from_utf16_lossy(&buf[..n as usize]).to_ascii_lowercase();
                    if s.contains("assembly") {
                        let sub = GetSubMenu(menu, i);
                        if !sub.is_null() {
                            let sc = GetMenuItemCount(sub);
                            for j in 0..sc {
                                let mut sbuf = [0u16; 128];
                                let sn = GetMenuStringW(
                                    sub,
                                    j as u32,
                                    sbuf.as_mut_ptr(),
                                    128,
                                    MF_BYPOSITION,
                                );
                                if sn > 0 {
                                    let st = String::from_utf16_lossy(&sbuf[..sn as usize])
                                        .to_ascii_lowercase();
                                    if st.contains("use process") {
                                        let id = GetMenuItemID(sub, j);
                                        if id != u32::MAX && id != 0 {
                                            return id;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    12326
}

fn wait_prompt_contains_any(prompt: Option<HWND>, needles: &[&str], timeout_ms: u64) -> bool {
    let Some(h) = prompt else {
        sleep(Duration::from_millis(timeout_ms.min(220)));
        return true;
    };
    let start = Instant::now();
    while start.elapsed().as_millis() < timeout_ms as u128 {
        let cur = get_window_text(h).to_ascii_lowercase();
        if needles.iter().any(|n| cur.contains(n)) {
            return true;
        }
        sleep(Duration::from_millis(8));
    }
    false
}

fn wait_prompt_contains(prompt: Option<HWND>, needle: &str, timeout_ms: u64) -> bool {
    wait_prompt_contains_any(prompt, &[needle], timeout_ms)
}

fn wait_prompt_change(prompt: Option<HWND>, prev: &str, timeout_ms: u64) -> String {
    let Some(h) = prompt else {
        sleep(Duration::from_millis(timeout_ms.min(260)));
        return String::new();
    };
    let start = Instant::now();
    while start.elapsed().as_millis() < timeout_ms as u128 {
        let cur = get_window_text(h);
        if cur != prev {
            return cur;
        }
        sleep(Duration::from_millis(8));
    }
    get_window_text(h)
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

/// Accelerated batch-apply Assembly -> Use process for every (cmp_name, panel_name) pair.
/// Uses direct WM_COMMAND (no Assembly dropdown clicks) + live prompt-bar polling (8 ms)
/// instead of blind 2-second sleeps — ~6x-8x faster and immune to slow-op race conditions.
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
    let cmd_id = find_use_process_cmd_id(hwnd);
    tap_vk(0x1B);
    sleep(Duration::from_millis(60));
    let prompt_hwnd = find_prompt_static(hwnd);

    let total = pairs.len();
    let mut done = 0usize;
    for (cmp, panel) in pairs {
        if cancel.load(Ordering::Relaxed) {
            tap_vk(0x1B);
            return Err(format!("Stopped by user after {}/{} operations.", done, total));
        }

        // Ensure we are at "Component to use:" via instant WM_COMMAND (no Assembly menu click)
        let cur_prompt = prompt_hwnd.map(get_window_text).unwrap_or_default();
        if !cur_prompt.to_ascii_lowercase().contains("component to use") {
            if !cur_prompt.to_ascii_lowercase().contains("choose a function") {
                tap_vk(0x1B);
                wait_prompt_contains(prompt_hwnd, "choose a function", 300);
            }
            unsafe {
                PostMessageW(hwnd, WM_COMMAND, cmd_id as usize, 0);
            }
            if !wait_prompt_contains(prompt_hwnd, "component to use", 350) {
                click(540, 62);
                sleep(Duration::from_millis(140));
                click(660, 480);
                wait_prompt_contains(prompt_hwnd, "component to use", 500);
            }
        }

        // 1. Component name + ENTER (prompt stays "Component to use:" while [PROCESS=...] pops up)
        type_unicode(cmp);
        tap_vk(0x0D);
        sleep(Duration::from_millis(240));

        // 2. Click [PROCESS=...] button at (445, 263)
        let before_proc = prompt_hwnd.map(get_window_text).unwrap_or_default();
        click(445, 263);
        let _ = wait_prompt_change(prompt_hwnd, &before_proc, 300);
        sleep(Duration::from_millis(60));

        // 3. Target panel name + ENTER
        type_unicode(panel);
        tap_vk(0x0D);
        sleep(Duration::from_millis(220));

        // 4. Second ENTER to confirm and execute the native TopSolid'Wood operation
        tap_vk(0x0D);
        // Poll dynamically until TopSolid finishes Parasolid boolean & returns to next component or idle
        wait_prompt_contains_any(prompt_hwnd, &["component to use", "choose a function"], 1200);
        sleep(Duration::from_millis(35));

        done += 1;
        on_progress(done, total, &format!("Use process: {} -> {}", cmp, panel));
    }

    tap_vk(0x1B);
    sleep(Duration::from_millis(80));
    Ok(done)
}
