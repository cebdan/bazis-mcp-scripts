# TopSolid Native Process Engine (Zero-dependency PowerShell 5.1)
# 1. Generates cached exact-size native .top process variants (Parameter -> Modify parameter via Unicode SendInput)
# 2. Batch-applies Assembly -> Use process for every (cmpName, panelName) pair so every panel receives
#    100% native TopSolid'Wood operations (Wood -> Drilling / Groove / Pocket / Rabbet / Moulding)
#    with ZERO boolean AddSubtraction solids.

param(
    [Parameter(Mandatory = $true)]
    [string]$JobFile
)

$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class Ts6NativeUI {
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, UIntPtr dwExtraInfo);
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT { public uint type; public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
        public uint pad1;
        public uint pad2;
    }
    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    public static void TypeUnicode(string text) {
        foreach (char c in text) {
            INPUT[] inp = new INPUT[2];
            inp[0].type = 1; inp[0].ki.wScan = (ushort)c; inp[0].ki.dwFlags = 0x0004;
            inp[1].type = 1; inp[1].ki.wScan = (ushort)c; inp[1].ki.dwFlags = 0x0004 | 0x0002;
            SendInput(2, inp, Marshal.SizeOf(typeof(INPUT)));
            System.Threading.Thread.Sleep(10);
        }
    }
    public static void TapVk(byte vk) {
        keybd_event(vk, 0, 0, UIntPtr.Zero);
        System.Threading.Thread.Sleep(15);
        keybd_event(vk, 0, 2, UIntPtr.Zero);
        System.Threading.Thread.Sleep(25);
    }
    public static void Click(int x, int y) {
        SetCursorPos(x, y);
        System.Threading.Thread.Sleep(45);
        mouse_event(2, 0, 0, 0, UIntPtr.Zero);
        System.Threading.Thread.Sleep(25);
        mouse_event(4, 0, 0, 0, UIntPtr.Zero);
    }
    public static void ClearInput() {
        TapVk(0x24); // HOME
        keybd_event(0x10, 0, 0, UIntPtr.Zero); // SHIFT down
        TapVk(0x23); // END
        keybd_event(0x10, 0, 2, UIntPtr.Zero); // SHIFT up
        TapVk(0x08); // BS
    }
}
"@
[Ts6NativeUI]::SetProcessDPIAware() | Out-Null

function Focus-TopSolid {
    $p = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '^top6\d{2}$' -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if (-not $p) { throw "TopSolid window not found" }
    [Ts6NativeUI]::ShowWindow($p.MainWindowHandle, 3) | Out-Null
    [Ts6NativeUI]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
    Start-Sleep -Milliseconds 180
}

function Run-Vbs([string]$code) {
    $tmp = Join-Path $env:TEMP ("ts6_nat_" + [Guid]::NewGuid().ToString("N").Substring(0, 8) + ".vbs")
    $nl = [Environment]::NewLine
    $full = 'On Error Resume Next' + $nl +
        'Set app = CreateObject("TopSolid.Application")' + $nl +
        'Dim doc : Set doc = Nothing' + $nl +
        'If app.Documents.Count > 0 Then Set doc = app.CurrentDocument' + $nl +
        $code + $nl +
        'If Err.Number <> 0 Then WScript.Echo "VBS_ERR|" & Err.Number & "|" & Err.Description'
    [System.IO.File]::WriteAllText($tmp, $full, (New-Object System.Text.UTF8Encoding $false))
    try {
        return (& cscript.exe //Nologo $tmp 2>&1 | Out-String).Trim()
    } finally {
        Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    }
}

$job = Get-Content -Raw -Encoding UTF8 $JobFile | ConvertFrom-Json
$builtVariants = 0
$appliedOps = 0

# Phase 1: Build any missing cached exact-size .top variants via Parameter -> Modify parameter
if ($job.variants -and $job.variants.Count -gt 0) {
    foreach ($v in $job.variants) {
        if ((Test-Path $v.dst) -and (-not $v.force)) { continue }
        $dstDir = Split-Path -Parent $v.dst
        if (-not (Test-Path $dstDir)) { New-Item -ItemType Directory -Path $dstDir -Force | Out-Null }
        Copy-Item -Path $v.src -Destination $v.dst -Force

        $openVbs = 'app.Documents.Open "' + ($v.dst -replace '"', '""') + '"'
        Run-Vbs $openVbs | Out-Null
        Start-Sleep -Milliseconds 250

        Focus-TopSolid
        [Ts6NativeUI]::TapVk(0x1B)
        Start-Sleep -Milliseconds 100
        # Parameter (275, 62) -> Modify parameter (285, 185)
        [Ts6NativeUI]::Click(275, 62)
        Start-Sleep -Milliseconds 220
        [Ts6NativeUI]::Click(285, 185)
        Start-Sleep -Milliseconds 250

        foreach ($prop in $v.params.PSObject.Properties) {
            [Ts6NativeUI]::TypeUnicode([string]$prop.Name)
            [Ts6NativeUI]::TapVk(0x0D)
            Start-Sleep -Milliseconds 220
            [Ts6NativeUI]::ClearInput()
            [Ts6NativeUI]::TypeUnicode([string]$prop.Value)
            [Ts6NativeUI]::TapVk(0x0D)
            Start-Sleep -Milliseconds 260
        }

        [Ts6NativeUI]::TapVk(0x1B)
        Start-Sleep -Milliseconds 150
        $saveOut = Run-Vbs 'doc.Document.Save : doc.Document.Close False, False : WScript.Echo "SAVED_VAR"'
        $builtVariants++
    }
}

# Phase 2: Batch-apply Assembly -> Use process for every (cmpName, panelName) pair
if ($job.apply -and $job.apply.Count -gt 0) {
    Focus-TopSolid

    foreach ($item in $job.apply) {
        [Ts6NativeUI]::TapVk(0x1B)
        Start-Sleep -Milliseconds 120
        [Ts6NativeUI]::Click(540, 62)
        Start-Sleep -Milliseconds 220
        [Ts6NativeUI]::Click(660, 480)
        Start-Sleep -Milliseconds 280
        # 1. Component name + ENTER
        [Ts6NativeUI]::TypeUnicode([string]$item.cmp)
        [Ts6NativeUI]::TapVk(0x0D)
        Start-Sleep -Milliseconds 340
        # 2. Click [PROCESS=...] button at (445, 263)
        [Ts6NativeUI]::Click(445, 263)
        Start-Sleep -Milliseconds 300
        # 3. Target panel name + ENTER
        [Ts6NativeUI]::TypeUnicode([string]$item.panel)
        [Ts6NativeUI]::TapVk(0x0D)
        Start-Sleep -Milliseconds 360
        # 4. Second ENTER to confirm and execute native operation
        [Ts6NativeUI]::TapVk(0x0D)
        Start-Sleep -Milliseconds 420
        $appliedOps++
    }
    # Exit Use process cleanly
    [Ts6NativeUI]::TapVk(0x1B)
    Start-Sleep -Milliseconds 160
}

Write-Output ("NATIVE_DONE|variants=" + $builtVariants + "|applied=" + $appliedOps)
