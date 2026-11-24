# TopSolid'Wood 6.25 COM Bridge (Zero-dependency Windows PowerShell 5.1)
# Watches <repo>\.ts6-ipc\ for atomic JSON request files and executes COM commands
# against TopSolid.Application via cscript.exe (isolated per request).

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class Ts6Win32 {
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, UIntPtr dwExtraInfo);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
[Ts6Win32]::SetProcessDPIAware() | Out-Null

$RepoRoot = Split-Path -Parent $PSScriptRoot
$IpcDir = if ($env:TS6_IPC_DIR) { $env:TS6_IPC_DIR } else { Join-Path $RepoRoot ".ts6-ipc" }
$TemplatesDir = if ($env:TS6_TEMPLATES_DIR) { $env:TS6_TEMPLATES_DIR } else { Join-Path (Split-Path -Parent (Split-Path -Parent $RepoRoot)) "bazis\TopSolid_Templates" }

if (-not (Test-Path $IpcDir)) { New-Item -ItemType Directory -Path $IpcDir -Force | Out-Null }

function VbsStr([string]$s) {
    if ($null -eq $s) { return '""' }
    $clean = ($s -replace '[\r\n]+', ' ') -replace '"', '""'
    return '"' + $clean + '"'
}

function FmtNum($n) {
    $d = [double]$n
    if ([Math]::Abs($d) -lt 1e-9) { return "0" }
    return $d.ToString("0.######", [System.Globalization.CultureInfo]::InvariantCulture)
}

function RunVbs([string]$vbsCode) {
    $tmp = Join-Path $env:TEMP ("ts6_mcp_" + [Guid]::NewGuid().ToString("N").Substring(0, 8) + ".vbs")
    [System.IO.File]::WriteAllText($tmp, $vbsCode, (New-Object System.Text.UTF8Encoding $false))
    try {
        $out = & cscript.exe //Nologo $tmp 2>&1
        return (($out | Out-String).Trim())
    } finally {
        Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    }
}

function HandleCommand([string]$cmd, $p) {
    if ($cmd -eq "health") {
        $vbs = @"
On Error Resume Next
Set app = CreateObject("TopSolid.Application")
If Err.Number <> 0 Or app Is Nothing Then
  WScript.Echo "ERR|" & Err.Description
  WScript.Quit 0
End If
Dim dname : dname = ""
If app.Documents.Count > 0 Then dname = app.CurrentDocument.Name
WScript.Echo "OK|" & app.Version & "|" & app.Documents.Count & "|" & dname
"@
        $out = RunVbs $vbs
        $parts = $out.Split("|")
        if ($parts[0] -ne "OK") { throw ($out) }
        return @{
            ok = $true
            version = $parts[1]
            docCount = [int]$parts[2]
            currentDoc = if ($parts.Length -gt 3) { $parts[3] } else { "" }
            templatesDir = $TemplatesDir
        }
    }

    if ($cmd -eq "list_templates") {
        $exists = Test-Path $TemplatesDir
        $files = @()
        if ($exists) {
            $files = @(Get-ChildItem -Path $TemplatesDir -Filter *.top | Select-Object -ExpandProperty Name)
        }
        return @{ ok = $true; dir = $TemplatesDir; exists = $exists; templates = $files }
    }

    if ($cmd -eq "new_doc") {
        $vbs = @"
On Error Resume Next
Set app = CreateObject("TopSolid.Application")
Set doc = app.Documents.Add("top")
If Err.Number <> 0 Then WScript.Echo "ERR|" & Err.Description Else WScript.Echo "OK|" & doc.Name
"@
        $out = RunVbs $vbs
        $parts = $out.Split("|")
        if ($parts[0] -ne "OK") { throw ($out) }
        return @{ ok = $true; name = $parts[1] }
    }

    if ($cmd -eq "list_elements") {
        $vbs = @"
On Error Resume Next
Set app = CreateObject("TopSolid.Application")
If app.Documents.Count = 0 Then
  WScript.Echo "EMPTY"
  WScript.Quit 0
End If
Set doc = app.CurrentDocument
Dim i, sh, cmp
For i = 1 To CLng(doc.Shapes.Count)
  Set sh = doc.Shapes.Item(i)
  WScript.Echo "SHAPE|" & sh.Name & "|" & sh.Designation & "|" & sh.Reference & "|" & sh.Layer & "|" & sh.Operations.Count
Next
For i = 1 To CLng(doc.Components.Count)
  Set cmp = doc.Components.Item(i)
  WScript.Echo "COMP|" & cmp.Element.Name & "|" & cmp.Element.Designation & "|" & cmp.Code
Next
"@
        $out = RunVbs $vbs
        $shapes = @()
        $comps = @()
        if ($out -and $out -ne "EMPTY") {
            foreach ($line in ($out -split "`r?`n")) {
                $a = $line.Split("|")
                if ($a[0] -eq "SHAPE") {
                    $shapes += @{ name = $a[1]; designation = $a[2]; reference = $a[3]; layer = [int]$a[4]; opsCount = [int]$a[5] }
                } elseif ($a[0] -eq "COMP") {
                    $comps += @{ name = $a[1]; designation = $a[2]; code = $a[3] }
                }
            }
        }
        return @{ ok = $true; shapes = $shapes; components = $comps }
    }

    if ($cmd -eq "create_block") {
        $cx = FmtNum(([double]$p.cx) * 0.001)
        $cy = FmtNum(([double]$p.cy) * 0.001)
        $cz = FmtNum(([double]$p.cz) * 0.001)
        $lx = FmtNum(([double]$p.lx) * 0.001)
        $ly = FmtNum(([double]$p.ly) * 0.001)
        $lz = FmtNum(([double]$p.lz) * 0.001)
        $xx = FmtNum($(if ($null -ne $p.xx) { $p.xx } else { 1 }))
        $xy = FmtNum($(if ($null -ne $p.xy) { $p.xy } else { 0 }))
        $xz = FmtNum($(if ($null -ne $p.xz) { $p.xz } else { 0 }))
        $yx = FmtNum($(if ($null -ne $p.yx) { $p.yx } else { 0 }))
        $yy = FmtNum($(if ($null -ne $p.yy) { $p.yy } else { 1 }))
        $yz = FmtNum($(if ($null -ne $p.yz) { $p.yz } else { 0 }))
        $extra = @()
        if ($p.name) { $extra += "blk.Name = " + (VbsStr $p.name) }
        if ($p.designation) { $extra += "blk.Designation = " + (VbsStr $p.designation) }
        if ($p.reference) { $extra += "blk.Reference = " + (VbsStr $p.reference) }
        if ($p.layer) { $extra += "blk.Layer = " + ([int]$p.layer) }
        $vbs = @(
            "On Error Resume Next",
            'Set app = CreateObject("TopSolid.Application")',
            "Set doc = app.CurrentDocument",
            'If doc Is Nothing Then Set doc = app.Documents.Add("top")',
            "Set blk = doc.Shapes.AddBasicBlock($cx, $cy, $cz, $xx, $xy, $xz, $yx, $yy, $yz, $lx, $ly, $lz)",
            'If Err.Number <> 0 Or blk Is Nothing Then WScript.Echo "ERR|" & Err.Description : WScript.Quit 0'
        ) + $extra + @('WScript.Echo "OK|" & blk.Name')
        $out = RunVbs ($vbs -join "`r`n")
        $parts = $out.Split("|")
        if ($parts[0] -ne "OK") { throw ($out) }
        return @{ ok = $true; name = $parts[1] }
    }

    if ($cmd -eq "insert_component") {
        if (-not $p.file) { throw "Provide 'file'" }
        $fullPath = if ([System.IO.Path]::IsPathRooted($p.file)) { $p.file } else { Join-Path $TemplatesDir $p.file }
        $ox = FmtNum(([double]$p.ox) * 0.001)
        $oy = FmtNum(([double]$p.oy) * 0.001)
        $oz = FmtNum(([double]$p.oz) * 0.001)
        $xx = FmtNum($(if ($null -ne $p.xx) { $p.xx } else { 1 }))
        $xy = FmtNum($(if ($null -ne $p.xy) { $p.xy } else { 0 }))
        $xz = FmtNum($(if ($null -ne $p.xz) { $p.xz } else { 0 }))
        $yx = FmtNum($(if ($null -ne $p.yx) { $p.yx } else { 0 }))
        $yy = FmtNum($(if ($null -ne $p.yy) { $p.yy } else { 1 }))
        $yz = FmtNum($(if ($null -ne $p.yz) { $p.yz } else { 0 }))
        $fp = VbsStr $fullPath
        $orig = VbsStr($(if ($p.origin) { $p.origin } else { "" }))
        $vbs = @(
            "On Error Resume Next",
            'Set app = CreateObject("TopSolid.Application")',
            "Set doc = app.CurrentDocument",
            'If doc Is Nothing Then WScript.Echo "ERR|No active document" : WScript.Quit 0',
            "Set cs = doc.CoordinateSystems.AddBasic($ox, $oy, $oz, $xx, $xy, $xz, $yx, $yy, $yz)",
            "Set cmp = doc.Components.AddWithPositioningByCoordinateSystems($fp, $orig, cs)",
            'If Err.Number <> 0 Or cmp Is Nothing Then WScript.Echo "ERR|" & Err.Description Else WScript.Echo "OK|" & cmp.Element.Name'
        ) -join "`r`n"
        $out = RunVbs $vbs
        $parts = $out.Split("|")
        if ($parts[0] -ne "OK") { throw ($out) }
        return @{ ok = $true; component = $parts[1]; file = $fullPath }
    }

    if ($cmd -eq "eval_vbs") {
        if (-not $p.code) { throw "Provide 'code'" }
        $vbs = @(
            "On Error Resume Next",
            'Set app = CreateObject("TopSolid.Application")',
            "Dim doc : Set doc = Nothing",
            "If app.Documents.Count > 0 Then Set doc = app.CurrentDocument",
            [string]$p.code,
            'If Err.Number <> 0 Then WScript.Echo "VBS_ERR|" & Err.Number & "|" & Err.Description'
        ) -join "`r`n"
        $out = RunVbs $vbs
        return @{ ok = $true; output = $out }
    }

    if ($cmd -eq "focus_window") {
        $procName = if ($p.process) { [string]$p.process } else { "top625" }
        $proc = Get-Process -Name $procName -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
        if (-not $proc) { throw ("Window not found for process: " + $procName) }
        $hwnd = $proc.MainWindowHandle
        [Ts6Win32]::ShowWindow($hwnd, 3) | Out-Null
        [Ts6Win32]::SetForegroundWindow($hwnd) | Out-Null
        Start-Sleep -Milliseconds 150
        $rect = New-Object Ts6Win32+RECT
        [Ts6Win32]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
        return @{
            ok = $true
            title = $proc.MainWindowTitle
            left = $rect.Left
            top = $rect.Top
            width = $rect.Right - $rect.Left
            height = $rect.Bottom - $rect.Top
        }
    }

    if ($cmd -eq "screenshot") {
        $x = 0; $y = 0
        $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
        $w = $bounds.Width; $h = $bounds.Height
        if ($p.windowOnly -eq $true) {
            $proc = Get-Process -Name "top625" -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
            if ($proc) {
                $rect = New-Object Ts6Win32+RECT
                [Ts6Win32]::GetWindowRect($proc.MainWindowHandle, [ref]$rect) | Out-Null
                if (($rect.Right - $rect.Left) -gt 50 -and ($rect.Bottom - $rect.Top) -gt 50) {
                    $x = $rect.Left; $y = $rect.Top
                    $w = $rect.Right - $rect.Left; $h = $rect.Bottom - $rect.Top
                }
            }
        }
        $bmp = New-Object System.Drawing.Bitmap($w, $h)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.CopyFromScreen($x, $y, 0, 0, $bmp.Size)
        $g.Dispose()
        $outPath = Join-Path $IpcDir "last_screenshot.png"
        $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
        $bmp.Dispose()
        $bytes = [System.IO.File]::ReadAllBytes($outPath)
        return @{
            ok = $true
            path = $outPath
            left = $x
            top = $y
            width = $w
            height = $h
            sizeBytes = $bytes.Length
            base64 = [Convert]::ToBase64String($bytes)
        }
    }

    if ($cmd -eq "mouse_click") {
        $cx = [int]$p.x
        $cy = [int]$p.y
        $btn = if ($p.button) { ([string]$p.button).ToLower() } else { "left" }
        [Ts6Win32]::SetCursorPos($cx, $cy) | Out-Null
        Start-Sleep -Milliseconds 80
        if ($btn -eq "move") {
            # hover only
        } elseif ($btn -eq "right") {
            [Ts6Win32]::mouse_event(0x0008, 0, 0, 0, [UIntPtr]::Zero)
            Start-Sleep -Milliseconds 40
            [Ts6Win32]::mouse_event(0x0010, 0, 0, 0, [UIntPtr]::Zero)
        } elseif ($btn -eq "double") {
            [Ts6Win32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
            Start-Sleep -Milliseconds 30
            [Ts6Win32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
            Start-Sleep -Milliseconds 70
            [Ts6Win32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
            Start-Sleep -Milliseconds 30
            [Ts6Win32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
        } else {
            [Ts6Win32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
            Start-Sleep -Milliseconds 40
            [Ts6Win32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
        }
        Start-Sleep -Milliseconds 120
        return @{ ok = $true; x = $cx; y = $cy; button = $btn }
    }

    if ($cmd -eq "send_keys") {
        if (-not $p.keys) { throw "Provide 'keys'" }
        [System.Windows.Forms.SendKeys]::SendWait([string]$p.keys)
        Start-Sleep -Milliseconds 120
        return @{ ok = $true; keys = [string]$p.keys }
    }

    throw ("Unknown command: " + $cmd)
}

Write-Host "[ts6-bridge] TopSolid'Wood 6.25 COM bridge running (PowerShell, 0 dependencies)." -ForegroundColor Green
Write-Host "[ts6-bridge] IPC dir:       $IpcDir"
Write-Host "[ts6-bridge] Templates dir: $TemplatesDir"
Write-Host "[ts6-bridge] Press Ctrl+C to stop."

$utf8NoBom = New-Object System.Text.UTF8Encoding $false
while ($true) {
    $reqs = Get-ChildItem -Path $IpcDir -Filter "req-*.json" -ErrorAction SilentlyContinue
    foreach ($f in $reqs) {
        $id = $f.Name.Substring(4, $f.Name.Length - 9)
        $resTmp = Join-Path $IpcDir ("res-" + $id + ".tmp")
        $resFinal = Join-Path $IpcDir ("res-" + $id + ".json")
        try {
            $raw = [System.IO.File]::ReadAllText($f.FullName, [System.Text.Encoding]::UTF8)
            Remove-Item $f.FullName -Force -ErrorAction SilentlyContinue
            $req = $raw | ConvertFrom-Json
            $res = HandleCommand $req.cmd $req.params
            $payload = @{ id = $id; ok = $true; result = $res } | ConvertTo-Json -Depth 10 -Compress
        } catch {
            Remove-Item $f.FullName -Force -ErrorAction SilentlyContinue
            $payload = @{ id = $id; ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Depth 5 -Compress
        }
        [System.IO.File]::WriteAllText($resTmp, $payload, $utf8NoBom)
        Move-Item -Path $resTmp -Destination $resFinal -Force
    }
    Start-Sleep -Milliseconds 120
}
