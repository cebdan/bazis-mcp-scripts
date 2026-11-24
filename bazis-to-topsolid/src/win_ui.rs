#![cfg(windows)]

use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::sleep;
use std::time::Duration;

use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    keybd_event, mouse_event, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT,
    KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowTextLengthW, GetWindowTextW, IsWindowVisible, SetCursorPos,
    SetForegroundWindow, SetProcessDPIAware, ShowWindow, SW_MAXIMIZE,
};

pub fn init_dpi_aware() {
    unsafe {
        SetProcessDPIAware();
    }
}

unsafe extern "system" fn enum_cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
    if IsWindowVisible(hwnd) == 0 {
        return 1;
    }
    let len = GetWindowTextLengthW(hwnd);
    if len <= 0 {
        return 1;
    }
    let mut buf = vec![0u16; (len + 1) as usize];
    GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
    let title = String::from_utf16_lossy(&buf[..len as usize]);
    if title.contains("TopSolid") {
        let out = lparam as *mut HWND;
        *out = hwnd;
        return 0; // stop enumeration
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

pub fn focus_topsolid() -> Result<(), String> {
    let hwnd = find_topsolid_hwnd()
        .ok_or_else(|| "TopSolid 6.25 window not found. Make sure TopSolid is running.".to_string())?;
    unsafe {
        ShowWindow(hwnd, SW_MAXIMIZE);
        SetForegroundWindow(hwnd);
    }
    sleep(Duration::from_millis(180));
    Ok(())
}

pub fn click(x: i32, y: i32) {
    unsafe {
        SetCursorPos(x, y);
        sleep(Duration::from_millis(40));
        mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
        sleep(Duration::from_millis(20));
        mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
    }
}

pub fn tap_vk(vk: u8) {
    unsafe {
        keybd_event(vk, 0, 0, 0);
        sleep(Duration::from_millis(15));
        keybd_event(vk, 0, KEYEVENTF_KEYUP, 0);
        sleep(Duration::from_millis(20));
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
        sleep(Duration::from_millis(8));
    }
}

/// Modify named parameters in the currently active TopSolid template document
/// via Parameter -> Modify parameter.
pub fn modify_active_doc_params(params: &[(String, String)]) -> Result<(), String> {
    focus_topsolid()?;
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
        sleep(Duration::from_millis(200));
        clear_input();
        type_unicode(v);
        tap_vk(0x0D);
        sleep(Duration::from_millis(240));
    }

    tap_vk(0x1B);
    sleep(Duration::from_millis(120));
    Ok(())
}

/// Batch-apply Assembly -> Use process for every (cmp_name, panel_name) pair.
/// Both cmp_name and panel_name MUST be strictly alphanumeric (no underscores)
/// because TopSolid 6.25's prompt expression parser rejects underscores.
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
    focus_topsolid()?;

    let total = pairs.len();
    let mut done = 0usize;
    for (cmp, panel) in pairs {
        if cancel.load(Ordering::Relaxed) {
            tap_vk(0x1B);
            return Err(format!("Stopped by user after {}/{} operations.", done, total));
        }
        // Reset cleanly to idle, then open Assembly (540, 62) -> Use process (660, 480)
        tap_vk(0x1B);
        sleep(Duration::from_millis(120));
        click(540, 62);
        sleep(Duration::from_millis(220));
        click(660, 480);
        sleep(Duration::from_millis(280));
        // 1. Component name + ENTER
        type_unicode(cmp);
        tap_vk(0x0D);
        sleep(Duration::from_millis(340));
        // 2. Click [PROCESS=...] button at (445, 263)
        click(445, 263);
        sleep(Duration::from_millis(300));
        // 3. Target panel name + ENTER
        type_unicode(panel);
        tap_vk(0x0D);
        sleep(Duration::from_millis(360));
        // 4. Second ENTER to confirm and execute the native TopSolid'Wood operation
        tap_vk(0x0D);
        sleep(Duration::from_millis(420));

        done += 1;
        on_progress(done, total, &format!("Use process: {} -> {}", cmp, panel));
    }

    // Exit Use process cleanly
    tap_vk(0x1B);
    sleep(Duration::from_millis(160));
    Ok(done)
}
