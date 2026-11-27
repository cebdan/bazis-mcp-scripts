# TopSolid MCP Bridge & System Tray App (Zero-dependency Windows PowerShell 5.1)
# Watches <repo>\.ts6-ipc\ for atomic JSON request files and executes COM commands
# against TopSolid.Application via cscript.exe (isolated per request).
# Features: System Tray icon (left-click Info, right-click Settings/Menu),
# Windows Service (Task Scheduler interactive autostart), Start Menu section,
# GitHub update checker & updater, and single-instance remote signaling.

param(
    [switch]$NoTray,
    [switch]$OpenInfo,
    [switch]$OpenSettings,
    [switch]$CheckUpdate,
    [switch]$InstallService,
    [switch]$UninstallService,
    [switch]$InstallStartMenu,
    [switch]$UninstallStartMenu,
    [switch]$InstallAll,
    [switch]$UninstallAll
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

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
    [DllImport("user32.dll", SetLastError = true)] public static extern bool DestroyIcon(IntPtr hIcon);
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
[Ts6Win32]::SetProcessDPIAware() | Out-Null

# ============================================================================
# Paths, Version & Persistent Config
# ============================================================================
$script:RepoRoot = Split-Path -Parent $PSScriptRoot
$script:VersionFile = Join-Path $script:RepoRoot "version.json"
$script:IconFile = Join-Path $script:RepoRoot "assets\ts6_mcp.ico"
$script:LauncherVbs = Join-Path $PSScriptRoot "ts6_tray_launcher.vbs"
$script:AppDataDir = Join-Path $env:APPDATA "TopSolid6MCP"
$script:ConfigPath = Join-Path $script:AppDataDir "config.json"
$script:LogPath = Join-Path $script:AppDataDir "bridge.log"
$script:UiCmdPath = Join-Path $script:AppDataDir "ui-cmd.json"
$script:TaskName = "TopSolid6McpBridge"
$script:StartMenuFolder = Join-Path ([Environment]::GetFolderPath("Programs")) "TopSolid MCP"
$script:Utf8NoBom = New-Object System.Text.UTF8Encoding $false

if (-not (Test-Path $script:AppDataDir)) {
    New-Item -ItemType Directory -Path $script:AppDataDir -Force | Out-Null
}

$script:AppVersion = "0.2.0"
$script:DefaultRepo = "cebdan/bazis-mcp-scripts"
$script:DefaultBranch = "main"
if (Test-Path $script:VersionFile) {
    try {
        $vMeta = [System.IO.File]::ReadAllText($script:VersionFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
        if ($vMeta.version) { $script:AppVersion = [string]$vMeta.version }
        if ($vMeta.repo) { $script:DefaultRepo = [string]$vMeta.repo }
        if ($vMeta.branch) { $script:DefaultBranch = [string]$vMeta.branch }
    } catch {}
}

$script:DefaultIpcDir = Join-Path $script:RepoRoot ".ts6-ipc"
$script:DefaultTemplatesDir = Join-Path (Split-Path -Parent (Split-Path -Parent $script:RepoRoot)) "bazis\TopSolid_Templates"

function New-RandomHttpToken {
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return ([Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_'))
}

function Resolve-NodeExe([string]$configured = "") {
    if ($configured -and (Test-Path $configured)) { return $configured }
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source -and (Test-Path $cmd.Source)) { return $cmd.Source }
    foreach ($cand in @(
        "C:\Program Files\nodejs\node.exe",
        "C:\Program Files (x86)\nodejs\node.exe",
        (Join-Path $env:LOCALAPPDATA "Programs\nodejs\node.exe")
    )) {
        if ($cand -and (Test-Path $cand)) { return $cand }
    }
    return "node.exe"
}

function Load-BridgeConfig {
    $defaultAllow = @("127.0.0.1", "::1", "10.211.55.0/24", "10.37.129.0/24", "192.168.0.0/16", "10.0.0.0/8", "172.16.0.0/12")
    $cfg = [ordered]@{
        ipcDir            = $script:DefaultIpcDir
        templatesDir      = $script:DefaultTemplatesDir
        topsolidExe       = ""
        pollIntervalMs    = 120
        githubRepo        = $script:DefaultRepo
        githubBranch      = $script:DefaultBranch
        autoCheckUpdates  = $true
        showNotifications = $true
        httpEnabled       = $true
        httpHost          = "0.0.0.0"
        httpPort          = 8765
        httpToken         = ""
        httpAllowFrom     = $defaultAllow
        nodeExe           = ""
    }
    $needSave = $false
    if (Test-Path $script:ConfigPath) {
        try {
            $saved = [System.IO.File]::ReadAllText($script:ConfigPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
            if ($saved.ipcDir) { $cfg.ipcDir = [string]$saved.ipcDir }
            if ($saved.templatesDir) { $cfg.templatesDir = [string]$saved.templatesDir }
            if ($null -ne $saved.topsolidExe) { $cfg.topsolidExe = [string]$saved.topsolidExe }
            if ($null -ne $saved.pollIntervalMs -and [int]$saved.pollIntervalMs -ge 30) { $cfg.pollIntervalMs = [int]$saved.pollIntervalMs }
            if ($saved.githubRepo) { $cfg.githubRepo = [string]$saved.githubRepo }
            if ($saved.githubBranch) { $cfg.githubBranch = [string]$saved.githubBranch }
            if ($null -ne $saved.autoCheckUpdates) { $cfg.autoCheckUpdates = [bool]$saved.autoCheckUpdates }
            if ($null -ne $saved.showNotifications) { $cfg.showNotifications = [bool]$saved.showNotifications }
            if ($null -ne $saved.httpEnabled) { $cfg.httpEnabled = [bool]$saved.httpEnabled }
            if ($saved.httpHost) { $cfg.httpHost = [string]$saved.httpHost }
            if ($null -ne $saved.httpPort -and [int]$saved.httpPort -gt 0) { $cfg.httpPort = [int]$saved.httpPort }
            if ($null -ne $saved.httpToken) { $cfg.httpToken = [string]$saved.httpToken }
            if ($null -ne $saved.httpAllowFrom -and @($saved.httpAllowFrom).Count -gt 0) {
                $cfg.httpAllowFrom = @($saved.httpAllowFrom | ForEach-Object { [string]$_ })
            }
            if ($null -ne $saved.nodeExe) { $cfg.nodeExe = [string]$saved.nodeExe }
        } catch {}
    } else {
        $needSave = $true
    }
    if (-not $cfg.httpToken) {
        $cfg.httpToken = New-RandomHttpToken
        $needSave = $true
    }
    if (-not $cfg.nodeExe) {
        $cfg.nodeExe = Resolve-NodeExe ""
    }
    if ($env:TS6_IPC_DIR) { $cfg.ipcDir = $env:TS6_IPC_DIR }
    if ($env:TS6_TEMPLATES_DIR) { $cfg.templatesDir = $env:TS6_TEMPLATES_DIR }
    if ($env:TS6_TOPSOLID_EXE) { $cfg.topsolidExe = $env:TS6_TOPSOLID_EXE }
    if ($env:TS6_HTTP_HOST) { $cfg.httpHost = $env:TS6_HTTP_HOST }
    if ($env:TS6_HTTP_PORT) { $cfg.httpPort = [int]$env:TS6_HTTP_PORT }
    if ($env:TS6_HTTP_TOKEN) { $cfg.httpToken = $env:TS6_HTTP_TOKEN }
    if ($needSave) {
        try {
            $json = $cfg | ConvertTo-Json -Depth 5
            [System.IO.File]::WriteAllText($script:ConfigPath, $json, $script:Utf8NoBom)
        } catch {}
    }
    return $cfg
}

function Get-InstalledTopSolidVersions {
    $found = New-Object System.Collections.Generic.List[object]
    $seen = @{}
    $roots = @("C:\Missler", "D:\Missler", "E:\Missler", "C:\Program Files\Missler", "C:\Program Files (x86)\Missler")
    foreach ($root in $roots) {
        if (-not (Test-Path $root)) { continue }
        Get-ChildItem -Path $root -Directory -Filter "V6*" -ErrorAction SilentlyContinue | ForEach-Object {
            $binDir = Join-Path $_.FullName "bin"
            if (Test-Path $binDir) {
                Get-ChildItem -Path $binDir -File -Filter "top6*.exe" -ErrorAction SilentlyContinue | ForEach-Object {
                    $p = $_.FullName
                    $k = $p.ToLowerInvariant()
                    if (-not $seen.ContainsKey($k)) {
                        $seen[$k] = $true
                        $ver = if ($p -match 'V6(\d\d)') { "6." + $Matches[1] } elseif ($p -match 'top6(\d\d)\.exe') { "6." + $Matches[1] } else { "6.xx" }
                        $found.Add([PSCustomObject]@{ version = $ver; exePath = $p; label = "TopSolid $ver ($p)" })
                    }
                }
            }
        }
    }
    return @($found | Sort-Object -Property version -Descending)
}

function Invoke-RebuildTemplates([string]$tplDir, [string]$tsExe) {
    $builder = Join-Path $PSScriptRoot "ts6_build_templates.ps1"
    if (-not (Test-Path $builder)) {
        [System.Windows.Forms.MessageBox]::Show("Template builder script not found:`n$builder", "Rebuild Templates", "OK", "Error") | Out-Null
        return
    }
    $verDesc = if ($tsExe) { $tsExe } else { "Auto (Active COM / Newest installed)" }
    $ans = [System.Windows.Forms.MessageBox]::Show(
        "Rebuild all 6 base B&S_*.top templates now?`n`nTemplates folder:`n$tplDir`n`nTopSolid version:`n$verDesc`n`nNote: Save any open TopSolid projects first.",
        "Rebuild TopSolid Templates",
        [System.Windows.Forms.MessageBoxButtons]::OKCancel,
        [System.Windows.Forms.MessageBoxIcon]::Question
    )
    if ($ans -ne [System.Windows.Forms.DialogResult]::OK) { return }
    $argList = @(
        "-NoProfile", "-ExecutionPolicy", "Bypass",
        "-File", "`"$builder`"",
        "-TemplatesDir", "`"$tplDir`"",
        "-Force", "-PauseOnExit"
    )
    if ($tsExe) {
        $argList += @("-TopSolidExe", "`"$tsExe`"")
    }
    Start-Process -FilePath "powershell.exe" -ArgumentList ($argList -join " ")
    Write-BridgeLog "Launched template rebuild in $tplDir (exe='$tsExe')."
}

function Save-BridgeConfig($cfg) {
    $json = $cfg | ConvertTo-Json -Depth 5
    [System.IO.File]::WriteAllText($script:ConfigPath, $json, $script:Utf8NoBom)
}

$script:Config = Load-BridgeConfig
$script:IpcDir = $script:Config.ipcDir
$script:TemplatesDir = $script:Config.templatesDir
if (-not (Test-Path $script:IpcDir)) { New-Item -ItemType Directory -Path $script:IpcDir -Force | Out-Null }

# Clean up stale res-*.json older than 10 minutes on startup
try {
    $cutoff = (Get-Date).AddMinutes(-10)
    Get-ChildItem -Path $script:IpcDir -Filter "res-*.json" -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -lt $cutoff } | Remove-Item -Force -ErrorAction SilentlyContinue
} catch {}

# HTTP MCP Gateway process state & supervisor
$script:HttpPidPath = Join-Path $script:AppDataDir "http.pid"
$script:HttpProc = $null
$script:HttpMode = "down"          # owned | adopted | down | blocked
$script:HttpBlockedPid = 0
$script:HttpLastError = ""
$script:HttpBackoffSec = 3
$script:HttpNextCheckAt = [DateTime]::MinValue
$script:HttpStartedAt = [DateTime]::MinValue
$script:HttpLastLogMsg = ""
$script:HttpLastLogAt = [DateTime]::MinValue
$script:HttpHealthCacheVal = $false
$script:HttpHealthCacheAt = [DateTime]::MinValue
$script:HttpHealthCachePid = 0

function Write-HttpStateLog([string]$msg, [string]$level = "INFO") {
    $now = Get-Date
    if ($msg -eq $script:HttpLastLogMsg -and (($now - $script:HttpLastLogAt).TotalSeconds -lt 300)) {
        return
    }
    $script:HttpLastLogMsg = $msg
    $script:HttpLastLogAt = $now
    Write-BridgeLog $msg $level
}

function Get-ExpectedHttpCfgHash {
    $raw = "$($script:IpcDir)|$([int]$script:Config.httpPort)|$($script:Config.httpToken)|$(@($script:Config.httpAllowFrom) -join ',')"
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($raw)
        $hash = $sha.ComputeHash($bytes)
        return ([BitConverter]::ToString($hash).Replace("-", "").ToLowerInvariant().Substring(0, 12))
    } finally {
        $sha.Dispose()
    }
}

function Get-LocalIPv4List {
    $vpnPattern = 'Mullvad|WireGuard|Wintun|TAP|OpenVPN|Tailscale|ZeroTier'
    $profileByAlias = @{}
    $profileByIndex = @{}
    try {
        foreach ($prof in @(Get-NetConnectionProfile -ErrorAction SilentlyContinue)) {
            $cat = [string]$prof.NetworkCategory
            if ($prof.InterfaceAlias) { $profileByAlias[$prof.InterfaceAlias] = $cat }
            if ($null -ne $prof.InterfaceIndex) { $profileByIndex[[int]$prof.InterfaceIndex] = $cat }
        }
    } catch {}

    $scored = New-Object System.Collections.Generic.List[object]
    $seen = @{}
    try {
        foreach ($ni in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
            if ($ni.OperationalStatus -ne [System.Net.NetworkInformation.OperationalStatus]::Up) { continue }
            if ($ni.NetworkInterfaceType -eq [System.Net.NetworkInformation.NetworkInterfaceType]::Loopback) { continue }
            if ($ni.NetworkInterfaceType -eq [System.Net.NetworkInformation.NetworkInterfaceType]::Tunnel) { continue }
            if ($ni.NetworkInterfaceType -eq [System.Net.NetworkInformation.NetworkInterfaceType]::Ppp) { continue }
            if ($ni.Name -match $vpnPattern -or $ni.Description -match $vpnPattern) { continue }

            $ipProps = $ni.GetIPProperties()
            $ifIdx = -1
            try { $ifIdx = [int]$ipProps.GetIPv4Properties().Index } catch {}
            $cat = "Public"
            if ($ifIdx -ge 0 -and $profileByIndex.ContainsKey($ifIdx)) {
                $cat = $profileByIndex[$ifIdx]
            } elseif ($profileByAlias.ContainsKey($ni.Name)) {
                $cat = $profileByAlias[$ni.Name]
            }
            $isPrivDomain = ($cat -eq "Private" -or $cat -eq "DomainAuthenticated")

            foreach ($ua in $ipProps.UnicastAddresses) {
                if ($ua.Address.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { continue }
                $ip = $ua.Address.IPAddressToString
                if (-not $ip -or $ip.StartsWith("169.254.") -or $ip -eq "127.0.0.1") { continue }
                if ($seen.ContainsKey($ip)) { continue }
                $seen[$ip] = $true

                $prio = if ($isPrivDomain) {
                    if ($ip.StartsWith("10.211.55.")) { 10 }
                    elseif ($ip.StartsWith("10.37.129.")) { 20 }
                    elseif ($ip -match '^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)') { 30 }
                    else { 40 }
                } else {
                    if ($ip.StartsWith("10.211.55.")) { 60 }
                    elseif ($ip.StartsWith("10.37.129.")) { 70 }
                    else { 80 }
                }
                $scored.Add([PSCustomObject]@{ ip = $ip; prio = $prio })
            }
        }
    } catch {}

    $result = New-Object System.Collections.Generic.List[string]
    foreach ($it in ($scored | Sort-Object -Property prio, ip)) {
        $result.Add([string]$it.ip)
    }
    $result.Add("127.0.0.1")
    return @($result)
}

function Probe-LocalHttpHealthz([int]$port, [bool]$force = $false) {
    $now = Get-Date
    if (-not $force -and (($now - $script:HttpHealthCacheAt).TotalSeconds -lt 5)) {
        return @{ ok = $script:HttpHealthCacheVal; pid = $script:HttpHealthCachePid; cfgHash = "" }
    }
    $script:HttpHealthCacheAt = $now
    try {
        $req = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$port/healthz")
        $req.Method = "GET"
        $req.Timeout = 1000
        $req.ReadWriteTimeout = 1000
        $resp = $req.GetResponse()
        try {
            $status = [int]$resp.StatusCode
            $sr = New-Object System.IO.StreamReader($resp.GetResponseStream())
            $body = $sr.ReadToEnd()
            $sr.Dispose()
            if ($status -eq 200) {
                $obj = $null
                try { $obj = $body | ConvertFrom-Json } catch {}
                $rPid = if ($obj -and $obj.pid) { [int]$obj.pid } else { 0 }
                $rHash = if ($obj -and $obj.cfgHash) { [string]$obj.cfgHash } else { "" }
                $script:HttpHealthCacheVal = $true
                $script:HttpHealthCachePid = $rPid
                return @{ ok = $true; pid = $rPid; cfgHash = $rHash }
            }
        } finally {
            $resp.Close()
        }
    } catch {}
    $script:HttpHealthCacheVal = $false
    $script:HttpHealthCachePid = 0
    return @{ ok = $false; pid = 0; cfgHash = "" }
}

function Get-PortListenerInfo([int]$port) {
    try {
        $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($conn -and $conn.OwningProcess -gt 0) {
            $ownerPid = [int]$conn.OwningProcess
            $pName = "unknown"
            $cmdLine = ""
            try {
                $cim = Get-CimInstance Win32_Process -Filter "ProcessId=$ownerPid" -ErrorAction SilentlyContinue
                if ($cim) {
                    $pName = [string]$cim.Name
                    $cmdLine = [string]$cim.CommandLine
                } else {
                    $gp = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
                    if ($gp) { $pName = $gp.ProcessName }
                }
            } catch {}
            return @{ pid = $ownerPid; name = $pName; commandLine = $cmdLine }
        }
    } catch {}
    return $null
}

function Test-IsOurGatewayProcess($listener, [int]$pidFilePid) {
    if (-not $listener) { return $false }
    if ($pidFilePid -gt 0 -and $listener.pid -eq $pidFilePid) { return $true }
    if ($listener.name -match '^node(\.exe)?$' -and $listener.commandLine -like '*index.mjs*--http*') { return $true }
    return $false
}

function Try-KillProcess([int]$targetPid) {
    if ($targetPid -le 0) { return @{ ok = $true; error = "" } }
    $errMsg = ""
    try {
        Stop-Process -Id $targetPid -Force -ErrorAction Stop
        Start-Sleep -Milliseconds 300
        if (-not (Get-Process -Id $targetPid -ErrorAction SilentlyContinue)) {
            return @{ ok = $true; error = "" }
        }
    } catch {
        $errMsg = $_.Exception.Message
    }
    try {
        $tkOut = (& taskkill.exe /PID $targetPid /T /F 2>&1) -join " "
        Start-Sleep -Milliseconds 300
        if (-not (Get-Process -Id $targetPid -ErrorAction SilentlyContinue)) {
            return @{ ok = $true; error = "" }
        }
        if ($tkOut) { $errMsg = "$errMsg | taskkill: $tkOut".Trim(" |") }
    } catch {
        $errMsg = "$errMsg | $($_.Exception.Message)".Trim(" |")
    }
    return @{ ok = $false; error = $errMsg }
}

function Read-HttpPidFile {
    try {
        if (Test-Path $script:HttpPidPath) {
            return ([System.IO.File]::ReadAllText($script:HttpPidPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json)
        }
    } catch {}
    return $null
}

function Get-HttpGatewayStatus {
    $port = [int]$script:Config.httpPort
    $ips = Get-LocalIPv4List
    $urls = @($ips | ForEach-Object { "http://$($_):$port/mcp" })
    $primary = if ($urls.Count -gt 0) { $urls[0] } else { "http://127.0.0.1:$port/mcp" }
    $probe = if ($script:Config.httpEnabled) { Probe-LocalHttpHealthz $port $false } else { @{ ok = $false; pid = 0 } }
    $hpid = 0
    if ($null -ne $script:HttpProc -and -not $script:HttpProc.HasExited) {
        $hpid = $script:HttpProc.Id
    } elseif ($probe.ok -and $probe.pid -gt 0) {
        $hpid = $probe.pid
    }
    return @{
        enabled   = [bool]$script:Config.httpEnabled
        listening = [bool]$probe.ok
        mode      = $script:HttpMode
        url       = $primary
        urls      = $urls
        pid       = $hpid
        lastError = $script:HttpLastError
    }
}

function Stop-HttpGateway {
    if ($null -ne $script:HttpProc) {
        $wasAdopted = ($script:HttpMode -eq "adopted")
        try {
            if (-not $wasAdopted -and -not $script:HttpProc.HasExited) {
                $script:HttpProc.Kill()
                $script:HttpProc.WaitForExit(2000) | Out-Null
            }
        } catch {}
        try { $script:HttpProc.Dispose() } catch {}
        $script:HttpProc = $null
    }
    $script:HttpMode = "down"
    $script:HttpHealthCacheAt = [DateTime]::MinValue
}

function Start-HttpGateway {
    Stop-HttpGateway
    $script:HttpLastError = ""
    $script:HttpBlockedPid = 0
    if (-not $script:Config.httpEnabled) {
        $script:HttpMode = "down"
        return
    }

    $port = [int]$script:Config.httpPort
    $expectedHash = Get-ExpectedHttpCfgHash
    $pidMeta = Read-HttpPidFile
    $pidFilePid = if ($pidMeta -and $pidMeta.pid) { [int]$pidMeta.pid } else { 0 }

    # Check if port is already occupied (or http.pid points to a live gateway)
    $listener = Get-PortListenerInfo $port
    if (-not $listener -and $pidFilePid -gt 0) {
        $gp = Get-Process -Id $pidFilePid -ErrorAction SilentlyContinue
        if ($gp -and $gp.ProcessName -match '^node$') {
            $listener = @{ pid = $pidFilePid; name = "node.exe"; commandLine = "index.mjs --http" }
        }
    }

    if ($listener) {
        $ownerPid = [int]$listener.pid
        if (Test-IsOurGatewayProcess $listener $pidFilePid) {
            $killRes = Try-KillProcess $ownerPid
            if ($killRes.ok) {
                Write-BridgeLog "Stopped previous/orphan HTTP gateway PID=$ownerPid."
            } else {
                Write-HttpStateLog "Orphan gateway PID=$ownerPid kill failed: $($killRes.error)" "WARN"
                $probe = Probe-LocalHttpHealthz $port $true
                if ($probe.ok -and $probe.cfgHash -and ($probe.cfgHash -eq $expectedHash)) {
                    try { $script:HttpProc = Get-Process -Id $ownerPid -ErrorAction Stop } catch { $script:HttpProc = $null }
                    $script:HttpMode = "adopted"
                    $script:HttpLastError = ""
                    $script:HttpStartedAt = Get-Date
                    $script:HttpBackoffSec = 3
                    Write-HttpStateLog "Adopted existing gateway PID=$ownerPid (cfgHash=$($probe.cfgHash))." "INFO"
                    return
                } else {
                    $script:HttpMode = "blocked"
                    $script:HttpBlockedPid = $ownerPid
                    $script:HttpLastError = "Port $port busy by PID $ownerPid (stale config, needs elevated kill)"
                    Write-HttpStateLog $script:HttpLastError "WARN"
                    if (-not $NoTray) {
                        Show-TrayBalloon "HTTP Gateway Blocked" "Port $port is held by stale gateway PID $ownerPid. Right-click tray -> Kill stale gateway (admin)." "Warning"
                    }
                    $script:HttpNextCheckAt = (Get-Date).AddSeconds($script:HttpBackoffSec)
                    $script:HttpBackoffSec = [Math]::Min(300, $script:HttpBackoffSec * 2)
                    return
                }
            }
        } else {
            $script:HttpMode = "blocked"
            $script:HttpBlockedPid = $ownerPid
            $script:HttpLastError = "Port $port in use by $($listener.name) PID $ownerPid"
            Write-HttpStateLog $script:HttpLastError "WARN"
            $script:HttpNextCheckAt = (Get-Date).AddSeconds($script:HttpBackoffSec)
            $script:HttpBackoffSec = [Math]::Min(300, $script:HttpBackoffSec * 2)
            return
        }
    }

    $serverEntry = Join-Path $script:RepoRoot "server\index.mjs"
    if (-not (Test-Path $serverEntry)) {
        $script:HttpMode = "down"
        $script:HttpLastError = "server/index.mjs not found at $serverEntry"
        Write-HttpStateLog "HTTP Gateway: $($script:HttpLastError)" "ERROR"
        return
    }
    $nodeBin = Resolve-NodeExe $script:Config.nodeExe
    try {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $nodeBin
        $psi.Arguments = "`"$serverEntry`" --http"
        $psi.WorkingDirectory = $script:RepoRoot
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $psi.EnvironmentVariables["TS6_IPC_DIR"] = $script:IpcDir
        $psi.EnvironmentVariables["TS6_HTTP_HOST"] = [string]$script:Config.httpHost
        $psi.EnvironmentVariables["TS6_HTTP_PORT"] = [string]$script:Config.httpPort
        $psi.EnvironmentVariables["TS6_HTTP_TOKEN"] = [string]$script:Config.httpToken
        $psi.EnvironmentVariables["TS6_HTTP_ALLOW_FROM"] = (@($script:Config.httpAllowFrom) -join ",")
        $psi.EnvironmentVariables["TS6_LOG_PATH"] = $script:LogPath
        $psi.EnvironmentVariables["TS6_CONFIG_PATH"] = $script:ConfigPath
        $psi.EnvironmentVariables["TS6_PARENT_PID"] = [string]$PID
        $script:HttpProc = [System.Diagnostics.Process]::Start($psi)
        $script:HttpMode = "owned"
        $script:HttpStartedAt = Get-Date
        $script:HttpHealthCacheAt = [DateTime]::MinValue
        Write-BridgeLog "HTTP MCP Gateway started (PID=$($script:HttpProc.Id), http://$($script:Config.httpHost):$port/mcp, IPC=$($script:IpcDir))."
    } catch {
        $script:HttpMode = "down"
        $script:HttpLastError = $_.Exception.Message
        Write-HttpStateLog "HTTP Gateway start failed: $($script:HttpLastError)" "ERROR"
        $script:HttpNextCheckAt = (Get-Date).AddSeconds($script:HttpBackoffSec)
        $script:HttpBackoffSec = [Math]::Min(300, $script:HttpBackoffSec * 2)
    }
}

function Ensure-HttpGatewayAlive {
    if (-not $script:Config.httpEnabled) { return }
    $now = Get-Date

    if ($null -ne $script:HttpProc -and -not $script:HttpProc.HasExited) {
        if ($script:HttpBackoffSec -gt 3 -and (($now - $script:HttpStartedAt).TotalSeconds -ge 60)) {
            $script:HttpBackoffSec = 3
        }
        return
    }

    # If our process just exited with code 98 (EADDRINUSE), run port-occupied logic immediately
    if ($null -ne $script:HttpProc -and $script:HttpProc.HasExited) {
        $exitCode = 0
        try { $exitCode = [int]$script:HttpProc.ExitCode } catch {}
        try { $script:HttpProc.Dispose() } catch {}
        $script:HttpProc = $null
        $script:HttpMode = "down"
        if ($exitCode -eq 98) {
            Start-HttpGateway
            return
        }
        Write-HttpStateLog "HTTP Gateway exited (code=$exitCode); will restart in $($script:HttpBackoffSec)s." "WARN"
        $script:HttpNextCheckAt = $now.AddSeconds($script:HttpBackoffSec)
        $script:HttpBackoffSec = [Math]::Min(300, $script:HttpBackoffSec * 2)
        return
    }

    # Mode is down or blocked — re-check when backoff timer expires
    if ($now -lt $script:HttpNextCheckAt) { return }
    Start-HttpGateway
}

function Build-ClientConfigText {
    $port = [int]$script:Config.httpPort
    $tok = [string]$script:Config.httpToken
    $ips = Get-LocalIPv4List
    $vmIp = ($ips | Where-Object { $_ -ne "127.0.0.1" } | Select-Object -First 1)
    if (-not $vmIp) { $vmIp = "127.0.0.1" }
    $lines = @(
        "# Claude Code (Mac -> Windows VM):",
        "claude mcp add --transport http --scope user topsolid6 http://$($vmIp):$port/mcp --header `"Authorization: Bearer $tok`"",
        "",
        "# Claude Code (Windows local):",
        "claude mcp add --transport http --scope user topsolid6 http://127.0.0.1:$port/mcp --header `"Authorization: Bearer $tok`"",
        "",
        "# stdio-only MCP client fallback (JSON):",
        "{",
        "  `"mcpServers`": {",
        "    `"topsolid6`": {",
        "      `"command`": `"node`",",
        "      `"args`": [`"<repo>/server/index.mjs`", `"--remote`", `"http://$($vmIp):$port/mcp`"],",
        "      `"env`": { `"TS6_HTTP_TOKEN`": `"$tok`" }",
        "    }",
        "  }",
        "}"
    )
    return ($lines -join "`r`n")
}

# ============================================================================
# Logging & Telemetry State
# ============================================================================
$script:StartTime = Get-Date
$script:RequestCount = 0
$script:ErrorCount = 0
$script:LastCommand = "None"
$script:LastCommandTime = $null
$script:IsPaused = $false
$script:TopSolidRunning = $false
$script:LastHealth = $null
$script:LastUpdateResult = $null
$script:LogLines = New-Object System.Collections.Generic.List[string]
$script:InfoForm = $null
$script:SettingsForm = $null
$script:NotifyIcon = $null
$script:CurrentTrayIconHandle = [IntPtr]::Zero
$script:IpcTimer = $null

function Write-BridgeLog([string]$msg, [string]$level = "INFO") {
    $ts = (Get-Date).ToString("HH:mm:ss")
    $line = "[$ts] [$level] $msg"
    $script:LogLines.Add($line)
    while ($script:LogLines.Count -gt 120) { $script:LogLines.RemoveAt(0) }
    try {
        if ((Test-Path $script:LogPath) -and ((Get-Item $script:LogPath).Length -gt 524288)) {
            $tail = Get-Content $script:LogPath -Tail 400 -ErrorAction SilentlyContinue
            [System.IO.File]::WriteAllLines($script:LogPath, $tail, $script:Utf8NoBom)
        }
        [System.IO.File]::AppendAllText($script:LogPath, $line + "`r`n", $script:Utf8NoBom)
    } catch {}
    if ($NoTray) {
        Write-Host $line
    }
}

# ============================================================================
# Windows Service (Interactive Scheduled Task) & Start Menu Management
# ============================================================================
function Get-BridgeServiceStatus {
    try {
        $t = Get-ScheduledTask -TaskName $script:TaskName -ErrorAction SilentlyContinue
        if ($t) {
            return @{ installed = $true; state = [string]$t.State; taskName = $script:TaskName }
        }
    } catch {}
    return @{ installed = $false; state = "NotInstalled"; taskName = $script:TaskName }
}

function Install-BridgeService {
    if (-not (Test-Path $script:LauncherVbs)) {
        throw ("Silent launcher not found: " + $script:LauncherVbs)
    }
    $action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument ("//B `"" + $script:LauncherVbs + "`"") -WorkingDirectory $script:RepoRoot
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -RestartCount 999 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -MultipleInstances IgnoreNew
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask `
        -TaskName $script:TaskName `
        -Action $action `
        -Trigger $trigger `
        -Settings $settings `
        -Principal $principal `
        -Description "TopSolid MCP Bridge (Interactive COM + System Tray Service)" `
        -Force | Out-Null
    Write-BridgeLog "Installed Windows service task '$($script:TaskName)' (AtLogOn, interactive, auto-restart)."
    $fwPort = [int]$script:Config.httpPort
    $fwCmd = "netsh advfirewall firewall add rule name=`"TopSolid MCP HTTP`" dir=in action=allow protocol=TCP localport=$fwPort profile=private,domain"
    try {
        $null = netsh advfirewall firewall delete rule name="TopSolid MCP HTTP" 2>$null
        $fwOut = netsh advfirewall firewall add rule name="TopSolid MCP HTTP" dir=in action=allow protocol=TCP localport=$fwPort profile=private,domain 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-BridgeLog "Added Windows Firewall rule 'TopSolid MCP HTTP' (TCP $fwPort, private+domain)."
        } else {
            Write-BridgeLog "Firewall rule requires Administrator rights. Run manually in elevated cmd: $fwCmd" "WARN"
        }
    } catch {
        Write-BridgeLog "Firewall rule requires Administrator rights. Run manually: $fwCmd" "WARN"
    }
}

function Uninstall-BridgeService {
    try {
        $t = Get-ScheduledTask -TaskName $script:TaskName -ErrorAction SilentlyContinue
        if ($t) {
            Unregister-ScheduledTask -TaskName $script:TaskName -Confirm:$false
            Write-BridgeLog "Removed Windows service task '$($script:TaskName)'."
        }
        try { $null = netsh advfirewall firewall delete rule name="TopSolid MCP HTTP" 2>$null } catch {}
    } catch {
        throw ("Failed to remove service task: " + $_.Exception.Message)
    }
}

function Get-StartMenuStatus {
    $exists = Test-Path $script:StartMenuFolder
    $count = 0
    if ($exists) {
        $count = @(Get-ChildItem -Path $script:StartMenuFolder -Filter "*.lnk" -ErrorAction SilentlyContinue).Count
    }
    return @{ installed = ($exists -and $count -gt 0); folder = $script:StartMenuFolder; shortcutCount = $count }
}

function New-ShortcutFile([string]$lnkPath, [string]$target, [string]$args, [string]$workDir, [string]$desc, [string]$iconLoc) {
    $ws = New-Object -ComObject WScript.Shell
    $sc = $ws.CreateShortcut($lnkPath)
    $sc.TargetPath = $target
    if ($args) { $sc.Arguments = $args }
    if ($workDir) { $sc.WorkingDirectory = $workDir }
    if ($desc) { $sc.Description = $desc }
    if ($iconLoc) { $sc.IconLocation = $iconLoc }
    $sc.Save()
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($sc) | Out-Null
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($ws) | Out-Null
}

function Install-StartMenuShortcuts {
    if (-not (Test-Path $script:StartMenuFolder)) {
        New-Item -ItemType Directory -Path $script:StartMenuFolder -Force | Out-Null
    }
    $ico = if (Test-Path $script:IconFile) { "$($script:IconFile),0" } else { "shell32.dll,21" }
    $wscript = Join-Path $env:WINDIR "System32\wscript.exe"
    $installBat = Join-Path $script:RepoRoot "Install_TopSolid6_MCP.bat"
    $uninstallBat = Join-Path $script:RepoRoot "Uninstall_TopSolid6_MCP.bat"

    New-ShortcutFile (Join-Path $script:StartMenuFolder "TopSolid MCP Bridge.lnk") `
        $wscript ("//B `"" + $script:LauncherVbs + "`"") $script:RepoRoot `
        "Start TopSolid MCP Bridge in System Tray" $ico

    New-ShortcutFile (Join-Path $script:StartMenuFolder "TopSolid MCP Info.lnk") `
        $wscript ("//B `"" + $script:LauncherVbs + "`" -OpenInfo") $script:RepoRoot `
        "Open TopSolid MCP Bridge Status & Information" $ico

    New-ShortcutFile (Join-Path $script:StartMenuFolder "TopSolid MCP Settings.lnk") `
        $wscript ("//B `"" + $script:LauncherVbs + "`" -OpenSettings") $script:RepoRoot `
        "Configure TopSolid MCP Bridge Settings, Service & Updates" "shell32.dll,316"

    New-ShortcutFile (Join-Path $script:StartMenuFolder "Check for Updates.lnk") `
        $wscript ("//B `"" + $script:LauncherVbs + "`" -CheckUpdate") $script:RepoRoot `
        "Check GitHub for TopSolid MCP Bridge Updates" "shell32.dll,238"

    if (Test-Path $installBat) {
        New-ShortcutFile (Join-Path $script:StartMenuFolder "Install or Repair Service.lnk") `
            $installBat "" $script:RepoRoot `
            "Install TopSolid MCP Bridge as a Windows Autostart Service" "shell32.dll,162"
    }

    New-ShortcutFile (Join-Path $script:StartMenuFolder "Open IPC & Logs Folder.lnk") `
        "explorer.exe" ("`"" + $script:IpcDir + "`"") $script:IpcDir `
        "Open TopSolid MCP IPC folder" "shell32.dll,3"

    if (Test-Path $uninstallBat) {
        New-ShortcutFile (Join-Path $script:StartMenuFolder "Uninstall TopSolid MCP.lnk") `
            $uninstallBat "" $script:RepoRoot `
            "Uninstall TopSolid MCP Service and Start Menu shortcuts" "shell32.dll,131"
    }

    Write-BridgeLog "Created Start Menu section at '$($script:StartMenuFolder)'."
}

function Uninstall-StartMenuShortcuts {
    if (Test-Path $script:StartMenuFolder) {
        Remove-Item -Path $script:StartMenuFolder -Recurse -Force -ErrorAction SilentlyContinue
        Write-BridgeLog "Removed Start Menu section '$($script:StartMenuFolder)'."
    }
}

# ============================================================================
# CLI-only Install / Uninstall Modes (exit immediately without starting tray)
# ============================================================================
if ($InstallAll -or $UninstallAll -or $InstallService -or $UninstallService -or $InstallStartMenu -or $UninstallStartMenu) {
    try {
        if ($InstallAll -or $InstallService) { Install-BridgeService }
        if ($InstallAll -or $InstallStartMenu) { Install-StartMenuShortcuts }
        if ($UninstallAll -or $UninstallService) { Uninstall-BridgeService }
        if ($UninstallAll -or $UninstallStartMenu) { Uninstall-StartMenuShortcuts }
        Write-Host "[ts6-bridge] Completed requested installation/uninstallation action."
        exit 0
    } catch {
        Write-Error $_.Exception.Message
        exit 1
    }
}

# ============================================================================
# Single-Instance Mutex & Remote UI Signal
# ============================================================================
$script:Mutex = $null
if (-not $NoTray) {
    $createdNew = $false
    $script:Mutex = New-Object System.Threading.Mutex($true, "Local\TopSolid6McpBridge_v1", [ref]$createdNew)
    if (-not $createdNew) {
        $actionName = "open_info"
        if ($OpenSettings) { $actionName = "open_settings" }
        elseif ($CheckUpdate) { $actionName = "check_update" }
        elseif ($OpenInfo) { $actionName = "open_info" }
        $cmdJson = @{ action = $actionName; ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress
        [System.IO.File]::WriteAllText($script:UiCmdPath, $cmdJson, $script:Utf8NoBom)
        exit 0
    }
}

# ============================================================================
# GitHub Update Checker & Updater
# ============================================================================
function Compare-SemVer([string]$vLocal, [string]$vRemote) {
    try {
        $a = [version]($vLocal -replace '[^0-9\.]', '')
        $b = [version]($vRemote -replace '[^0-9\.]', '')
        if ($b -gt $a) { return 1 }
        if ($b -lt $a) { return -1 }
        return 0
    } catch {
        if ($vRemote -ne $vLocal) { return 1 }
        return 0
    }
}

function Get-LocalGitCommit {
    $parentDir = Split-Path -Parent $script:RepoRoot
    $gitDir = Join-Path $parentDir ".git"
    if (-not (Test-Path $gitDir)) { return $null }
    try {
        $sha = (& git -C $parentDir rev-parse HEAD 2>$null)
        if ($LASTEXITCODE -eq 0 -and $sha) { return ([string]$sha).Trim() }
    } catch {}
    return $null
}

function Test-GitHubUpdate {
    $repo = $script:Config.githubRepo
    $branch = $script:Config.githubBranch
    $headers = @{ "User-Agent" = "TopSolid6-MCP-Bridge/$($script:AppVersion)" }
    $result = @{
        ok              = $false
        checkedAt       = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
        repo            = $repo
        branch          = $branch
        localVersion    = $script:AppVersion
        remoteVersion   = $null
        remoteChangelog = ""
        remoteCommit    = $null
        localCommit     = (Get-LocalGitCommit)
        updateAvailable = $false
        releaseUrl      = "https://github.com/$repo/tree/$branch/topsolid-mcp"
        error           = $null
    }

    try {
        $verUrl = "https://raw.githubusercontent.com/$repo/$branch/topsolid-mcp/version.json?t=" + [DateTime]::UtcNow.Ticks
        $remoteMeta = Invoke-RestMethod -Uri $verUrl -Headers $headers -TimeoutSec 8 -ErrorAction Stop
        if ($remoteMeta.version) { $result.remoteVersion = [string]$remoteMeta.version }
        if ($remoteMeta.changelog) { $result.remoteChangelog = [string]$remoteMeta.changelog }
        $result.ok = $true
    } catch {
        $result.error = "version.json fetch failed: " + $_.Exception.Message
    }

    try {
        $commitUrl = "https://api.github.com/repos/$repo/commits?path=topsolid-mcp&sha=$branch&per_page=1"
        $commits = Invoke-RestMethod -Uri $commitUrl -Headers $headers -TimeoutSec 8 -ErrorAction Stop
        if ($commits -and $commits.Count -gt 0) {
            $result.remoteCommit = [string]$commits[0].sha
            if (-not $result.remoteChangelog -and $commits[0].commit.message) {
                $result.remoteChangelog = ([string]$commits[0].commit.message -split "`n")[0]
            }
            $result.ok = $true
            $result.error = $null
        }
    } catch {
        if (-not $result.ok) {
            $result.error = $_.Exception.Message
        }
    }

    if ($result.ok) {
        $verNewer = $false
        if ($result.remoteVersion) {
            $verNewer = ((Compare-SemVer $result.localVersion $result.remoteVersion) -gt 0)
        }
        $commitDiff = $false
        if ($result.remoteCommit -and $result.localCommit -and ($result.remoteCommit -ne $result.localCommit)) {
            $commitDiff = $true
        }
        $result.updateAvailable = ($verNewer -or ($commitDiff -and -not $result.remoteVersion))
    }

    $script:LastUpdateResult = $result
    return $result
}

function Invoke-GitHubUpdate {
    $repo = $script:Config.githubRepo
    $branch = $script:Config.githubBranch
    $parentDir = Split-Path -Parent $script:RepoRoot
    $gitDir = Join-Path $parentDir ".git"

    if ((Test-Path $gitDir) -and (Get-Command git -ErrorAction SilentlyContinue)) {
        $out = & git -C $parentDir pull --ff-only origin $branch 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-BridgeLog ("Git pull succeeded: " + (($out | Out-String).Trim()))
            return @{ ok = $true; method = "git"; message = (($out | Out-String).Trim()) }
        } else {
            Write-BridgeLog ("Git pull failed, falling back to direct download: " + (($out | Out-String).Trim())) "WARN"
        }
    }

    $files = @(
        "version.json",
        "README.md",
        "Start_TopSolid6_Bridge.bat",
        "Install_TopSolid6_MCP.bat",
        "Uninstall_TopSolid6_MCP.bat",
        "agent/ts6_bridge.ps1",
        "agent/ts6_tray_launcher.vbs",
        "server/index.mjs"
    )
    $headers = @{ "User-Agent" = "TopSolid6-MCP-Bridge/$($script:AppVersion)" }
    $updated = 0
    foreach ($rel in $files) {
        $url = "https://raw.githubusercontent.com/$repo/$branch/topsolid-mcp/$rel?t=" + [DateTime]::UtcNow.Ticks
        $dest = Join-Path $script:RepoRoot ($rel -replace '/', '\')
        $destDir = Split-Path -Parent $dest
        if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }
        $tmp = $dest + ".upd.tmp"
        try {
            Invoke-WebRequest -Uri $url -Headers $headers -OutFile $tmp -TimeoutSec 12 -UseBasicParsing -ErrorAction Stop
            Move-Item -Path $tmp -Destination $dest -Force
            $updated++
        } catch {
            Remove-Item $tmp -Force -ErrorAction SilentlyContinue
            Write-BridgeLog "Update skipped '$rel': $($_.Exception.Message)" "WARN"
        }
    }
    if ($updated -eq 0) {
        return @{ ok = $false; method = "raw"; message = "No files could be downloaded from GitHub ($repo/$branch)." }
    }
    Write-BridgeLog "Downloaded $updated updated files from GitHub ($repo/$branch)."
    return @{ ok = $true; method = "raw"; message = "Updated $updated files from GitHub ($repo/$branch)." }
}

# ============================================================================
# TopSolid COM / VBS Helpers & Command Dispatcher
# ============================================================================
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
    [System.IO.File]::WriteAllText($tmp, $vbsCode, $script:Utf8NoBom)
    try {
        $out = & cscript.exe //Nologo $tmp 2>&1
        return (($out | Out-String).Trim())
    } finally {
        Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    }
}

function Get-TopSolidProcess([string]$preferredName = "") {
    if ($preferredName) {
        return (Get-Process -Name $preferredName -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1)
    }
    $procs = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '^top6\d{2}$' }
    $withWin = $procs | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if ($withWin) { return $withWin }
    return ($procs | Select-Object -First 1)
}

function Get-TopSolidHealth {
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
    $h = @{
        ok           = $true
        version      = $parts[1]
        docCount     = [int]$parts[2]
        currentDoc   = if ($parts.Length -gt 3) { $parts[3] } else { "" }
        templatesDir = $script:TemplatesDir
        bridgeVersion = $script:AppVersion
    }
    $script:LastHealth = $h
    return $h
}

function HandleCommand([string]$cmd, $p) {
    if ($cmd -eq "health") {
        return (Get-TopSolidHealth)
    }

    if ($cmd -eq "bridge_info") {
        $uptime = [int]((Get-Date) - $script:StartTime).TotalSeconds
        $svc = Get-BridgeServiceStatus
        $sm = Get-StartMenuStatus
        return @{
            ok              = $true
            bridgeVersion   = $script:AppVersion
            pid             = $PID
            uptimeSec       = $uptime
            paused          = $script:IsPaused
            requestsHandled = $script:RequestCount
            errorCount      = $script:ErrorCount
            lastCommand     = $script:LastCommand
            ipcDir          = $script:IpcDir
            templatesDir    = $script:TemplatesDir
            configPath      = $script:ConfigPath
            logPath         = $script:LogPath
            service         = $svc
            startMenu       = $sm
            http            = (Get-HttpGatewayStatus)
            topSolidRunning = [bool](Get-TopSolidProcess)
            lastUpdateCheck = $script:LastUpdateResult
        }
    }

    if ($cmd -eq "check_updates") {
        return (Test-GitHubUpdate)
    }

    if ($cmd -eq "list_templates") {
        $exists = Test-Path $script:TemplatesDir
        $files = @()
        if ($exists) {
            $files = @(Get-ChildItem -Path $script:TemplatesDir -Filter *.top | Select-Object -ExpandProperty Name)
        }
        return @{ ok = $true; dir = $script:TemplatesDir; exists = $exists; templates = $files }
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
        $fullPath = if ([System.IO.Path]::IsPathRooted($p.file)) { $p.file } else { Join-Path $script:TemplatesDir $p.file }
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
        $procName = if ($p.process) { [string]$p.process } else { "" }
        $proc = Get-TopSolidProcess $procName
        if (-not $proc -or $proc.MainWindowHandle -eq 0) { throw ("TopSolid window not found" + $(if ($procName) { " for process: " + $procName } else { "" })) }
        $hwnd = $proc.MainWindowHandle
        [Ts6Win32]::ShowWindow($hwnd, 3) | Out-Null
        [Ts6Win32]::SetForegroundWindow($hwnd) | Out-Null
        Start-Sleep -Milliseconds 150
        $rect = New-Object Ts6Win32+RECT
        [Ts6Win32]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
        return @{
            ok     = $true
            title  = $proc.MainWindowTitle
            left   = $rect.Left
            top    = $rect.Top
            width  = $rect.Right - $rect.Left
            height = $rect.Bottom - $rect.Top
        }
    }

    if ($cmd -eq "screenshot") {
        $x = 0; $y = 0
        $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
        $w = $bounds.Width; $h = $bounds.Height
        if ($p.windowOnly -eq $true) {
            $proc = Get-TopSolidProcess
            if ($proc -and $proc.MainWindowHandle -ne 0) {
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
        $outPath = Join-Path $script:IpcDir "last_screenshot.png"
        $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
        $bmp.Dispose()
        $bytes = [System.IO.File]::ReadAllBytes($outPath)
        return @{
            ok        = $true
            path      = $outPath
            left      = $x
            top       = $y
            width     = $w
            height    = $h
            sizeBytes = $bytes.Length
            base64    = [Convert]::ToBase64String($bytes)
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

function Process-IpcQueue {
    if ($script:IsPaused) { return }
    if (-not (Test-Path $script:IpcDir)) { return }
    $reqs = Get-ChildItem -Path $script:IpcDir -Filter "req-*.json" -ErrorAction SilentlyContinue
    foreach ($f in $reqs) {
        $id = $f.Name.Substring(4, $f.Name.Length - 9)
        $resTmp = Join-Path $script:IpcDir ("res-" + $id + ".tmp")
        $resFinal = Join-Path $script:IpcDir ("res-" + $id + ".json")
        $cmdName = "unknown"
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        try {
            $raw = ""
            try {
                $raw = [System.IO.File]::ReadAllText($f.FullName, [System.Text.Encoding]::UTF8)
            } catch [System.IO.IOException] {
                # File is still being written by another process; retry on next poll without error
                continue
            }
            Remove-Item $f.FullName -Force -ErrorAction SilentlyContinue
            $req = $raw | ConvertFrom-Json
            $cmdName = [string]$req.cmd
            if ($null -ne $req.deadline) {
                $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
                if ($nowMs -gt [int64]$req.deadline) {
                    Write-BridgeLog "SKIP stale $cmdName (id=$id, expired by $($nowMs - [int64]$req.deadline) ms)" "WARN"
                    continue
                }
            }
            $script:LastCommand = $cmdName
            $script:LastCommandTime = Get-Date
            $res = HandleCommand $cmdName $req.params
            $script:RequestCount++
            $payload = @{ id = $id; ok = $true; result = $res } | ConvertTo-Json -Depth 10 -Compress
            $sw.Stop()
            Write-BridgeLog "$cmdName -> OK ($($sw.ElapsedMilliseconds) ms)"
        } catch {
            Remove-Item $f.FullName -Force -ErrorAction SilentlyContinue
            $script:ErrorCount++
            $sw.Stop()
            $errMsg = $_.Exception.Message
            $payload = @{ id = $id; ok = $false; error = $errMsg } | ConvertTo-Json -Depth 5 -Compress
            Write-BridgeLog "$cmdName -> ERR: $errMsg" "ERROR"
        }
        [System.IO.File]::WriteAllText($resTmp, $payload, $script:Utf8NoBom)
        Move-Item -Path $resTmp -Destination $resFinal -Force
        if (-not $NoTray) {
            [System.Windows.Forms.Application]::DoEvents()
        }
    }
}

# ============================================================================
# Headless Console Mode (--NoTray)
# ============================================================================
if ($NoTray) {
    Write-BridgeLog "TopSolid MCP Bridge v$($script:AppVersion) running (console mode)."
    Write-BridgeLog "IPC dir:       $($script:IpcDir)"
    Write-BridgeLog "Templates dir: $($script:TemplatesDir)"
    Start-HttpGateway
    try {
        $lastWatch = Get-Date
        while ($true) {
            Process-IpcQueue
            if (((Get-Date) - $lastWatch).TotalSeconds -ge 5) {
                Ensure-HttpGatewayAlive
                $lastWatch = Get-Date
            }
            Start-Sleep -Milliseconds $script:Config.pollIntervalMs
        }
    } finally {
        Stop-HttpGateway
    }
}

# ============================================================================
# System Tray Icon Drawing & Notifications
# ============================================================================
function New-StatusTrayIcon([string]$state) {
    $bmp = New-Object System.Drawing.Bitmap(32, 32)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
    $g.Clear([System.Drawing.Color]::Transparent)

    # Background rounded badge
    $bgBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 24, 62, 120))
    $accentBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 38, 166, 240))
    $borderPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 90, 150, 220), 1.5)
    $g.FillRectangle($bgBrush, 1, 1, 30, 30)
    $g.FillRectangle($accentBrush, 2, 2, 28, 4)
    $g.DrawRectangle($borderPen, 1, 1, 29, 29)

    # "TS" letters
    $font = New-Object System.Drawing.Font("Segoe UI", 11.5, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $sf = New-Object System.Drawing.StringFormat
    $sf.Alignment = [System.Drawing.StringAlignment]::Center
    $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
    $g.DrawString("TS", $font, [System.Drawing.Brushes]::White, (New-Object System.Drawing.RectangleF(0, 5, 30, 24)), $sf)

    # Status dot in bottom-right corner
    $dotColor = switch ($state) {
        "connected" { [System.Drawing.Color]::FromArgb(255, 34, 197, 94) }   # Green
        "waiting"   { [System.Drawing.Color]::FromArgb(255, 245, 158, 11) }  # Amber
        "paused"    { [System.Drawing.Color]::FromArgb(255, 148, 163, 184) } # Slate gray
        default     { [System.Drawing.Color]::FromArgb(255, 239, 68, 68) }   # Red
    }
    $dotBrush = New-Object System.Drawing.SolidBrush($dotColor)
    $dotBorder = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 15, 23, 42), 1.5)
    $g.FillEllipse($dotBrush, 20, 20, 10, 10)
    $g.DrawEllipse($dotBorder, 20, 20, 10, 10)

    $g.Dispose(); $bgBrush.Dispose(); $accentBrush.Dispose(); $borderPen.Dispose()
    $font.Dispose(); $sf.Dispose(); $dotBrush.Dispose(); $dotBorder.Dispose()

    $hIcon = $bmp.GetHicon()
    $icon = [System.Drawing.Icon]::FromHandle($hIcon)
    $bmp.Dispose()
    return @{ icon = $icon; handle = $hIcon }
}

function Update-TrayVisuals {
    $script:TopSolidRunning = [bool](Get-TopSolidProcess)
    $state = if ($script:IsPaused) { "paused" } elseif ($script:TopSolidRunning) { "connected" } else { "waiting" }
    $iconObj = New-StatusTrayIcon $state
    $oldHandle = $script:CurrentTrayIconHandle
    $script:NotifyIcon.Icon = $iconObj.icon
    $script:CurrentTrayIconHandle = $iconObj.handle
    if ($oldHandle -ne [IntPtr]::Zero) {
        [Ts6Win32]::DestroyIcon($oldHandle) | Out-Null
    }
    $statusTxt = switch ($state) {
        "connected" { "Connected (TopSolid open)" }
        "waiting"   { "Running (waiting for TopSolid)" }
        "paused"    { "Paused" }
        default     { "Error" }
    }
    # NotifyIcon.Text max length is 63 chars
    $tip = "TopSolid MCP v$($script:AppVersion) - $statusTxt"
    if ($tip.Length -gt 63) { $tip = $tip.Substring(0, 63) }
    $script:NotifyIcon.Text = $tip
}

function Show-TrayBalloon([string]$title, [string]$text, [string]$iconType = "Info") {
    if (-not $script:Config.showNotifications) { return }
    if ($null -eq $script:NotifyIcon) { return }
    $tipIcon = switch ($iconType) {
        "Warning" { [System.Windows.Forms.ToolTipIcon]::Warning }
        "Error"   { [System.Windows.Forms.ToolTipIcon]::Error }
        default   { [System.Windows.Forms.ToolTipIcon]::Info }
    }
    $script:NotifyIcon.ShowBalloonTip(3500, $title, $text, $tipIcon)
}

function Get-AppWindowIcon {
    if (Test-Path $script:IconFile) {
        try { return (New-Object System.Drawing.Icon($script:IconFile)) } catch {}
    }
    return [System.Drawing.SystemIcons]::Application
}

function Restart-BridgeProcess {
    Write-BridgeLog "Restarting TopSolid MCP Bridge..."
    if ($script:IpcTimer) { $script:IpcTimer.Stop() }
    if ($script:NotifyIcon) { $script:NotifyIcon.Visible = $false; $script:NotifyIcon.Dispose() }
    if ($script:Mutex) {
        try { $script:Mutex.ReleaseMutex() } catch {}
        $script:Mutex.Dispose()
    }
    if (Test-Path $script:LauncherVbs) {
        Start-Process -FilePath "wscript.exe" -ArgumentList ("//B `"" + $script:LauncherVbs + "`"") -WorkingDirectory $script:RepoRoot
    } else {
        Start-Process -FilePath "powershell.exe" -ArgumentList ("-WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File `"" + $PSCommandPath + "`"")
    }
    [System.Windows.Forms.Application]::Exit()
}

# ============================================================================
# Interactive GitHub Update Dialog
# ============================================================================
function Show-UpdateCheckDialog([bool]$silentIfUpToDate = $false) {
    $res = Test-GitHubUpdate
    if (-not $res.ok) {
        if (-not $silentIfUpToDate) {
            [System.Windows.Forms.MessageBox]::Show(
                "Could not check GitHub for updates.`r`n`r`nRepository: $($res.repo) ($($res.branch))`r`nError: $($res.error)",
                "TopSolid MCP - Update Check",
                [System.Windows.Forms.MessageBoxButtons]::OK,
                [System.Windows.Forms.MessageBoxIcon]::Warning
            ) | Out-Null
        }
        return
    }

    if ($res.updateAvailable) {
        $msg = "A new version of TopSolid MCP Bridge is available!`r`n`r`n" +
               "Installed: v$($res.localVersion)`r`n" +
               "Latest:    v$($res.remoteVersion)`r`n" +
               "Repo:      $($res.repo) ($($res.branch))`r`n"
        if ($res.remoteChangelog) {
            $msg += "`r`nChanges:`r`n$($res.remoteChangelog)`r`n"
        }
        $msg += "`r`nDo you want to download and install the update now?"
        $ans = [System.Windows.Forms.MessageBox]::Show(
            $msg,
            "TopSolid MCP - Update Available",
            [System.Windows.Forms.MessageBoxButtons]::YesNo,
            [System.Windows.Forms.MessageBoxIcon]::Information
        )
        if ($ans -eq [System.Windows.Forms.DialogResult]::Yes) {
            $upd = Invoke-GitHubUpdate
            if ($upd.ok) {
                [System.Windows.Forms.MessageBox]::Show(
                    "$($upd.message)`r`n`r`nThe bridge will now restart to apply the update.",
                    "TopSolid MCP - Update Complete",
                    [System.Windows.Forms.MessageBoxButtons]::OK,
                    [System.Windows.Forms.MessageBoxIcon]::Information
                ) | Out-Null
                Restart-BridgeProcess
            } else {
                [System.Windows.Forms.MessageBox]::Show(
                    "Update failed:`r`n$($upd.message)",
                    "TopSolid MCP - Update Error",
                    [System.Windows.Forms.MessageBoxButtons]::OK,
                    [System.Windows.Forms.MessageBoxIcon]::Error
                ) | Out-Null
            }
        }
    } elseif (-not $silentIfUpToDate) {
        $shaTxt = if ($res.remoteCommit) { " (commit " + $res.remoteCommit.Substring(0, 7) + ")" } else { "" }
        [System.Windows.Forms.MessageBox]::Show(
            "TopSolid MCP Bridge is up to date.`r`n`r`nInstalled version: v$($res.localVersion)$shaTxt`r`nRepository: $($res.repo) ($($res.branch))",
            "TopSolid MCP - Up to Date",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Information
        ) | Out-Null
    }
}

# ============================================================================
# DPI Scaling Helper & Left-Click Window: Information & Live Status
# ============================================================================
$script:DpiScale = 1.0
try {
    $gDpi = [System.Drawing.Graphics]::FromHwnd([IntPtr]::Zero)
    if ($gDpi.DpiX -gt 0) { $script:DpiScale = [double]$gDpi.DpiX / 96.0 }
    $gDpi.Dispose()
} catch {}

function S([double]$px) {
    return [int][Math]::Round($px * $script:DpiScale)
}

$script:InfoUI = $null
$script:InfoTimer = $null
$script:SettingsUI = $null

function Update-InfoWindowUI([bool]$probeCom = $false) {
    if ($null -eq $script:InfoUI -or $null -eq $script:InfoForm -or $script:InfoForm.IsDisposed) { return }
    $tsInfo = "Not running"
    if ($probeCom) {
        try {
            $h = Get-TopSolidHealth
            $docLabel = if ($h.currentDoc) { $h.currentDoc } else { "(none)" }
            $tsInfo = "Connected | Version $($h.version) | Open docs: $($h.docCount) | Active: $docLabel"
        } catch {
            $tsInfo = "Not connected ($($_.Exception.Message))"
        }
    } else {
        if (Get-TopSolidProcess) {
            if ($script:LastHealth) {
                $tsInfo = "Running | Version $($script:LastHealth.version) | Docs: $($script:LastHealth.docCount) (click Refresh COM)"
            } else {
                $tsInfo = "Process running (click Refresh COM for live check)"
            }
        }
    }
    $upSpan = (Get-Date) - $script:StartTime
    $upStr = "{0:00}h {1:00}m {2:00}s" -f [int]$upSpan.TotalHours, $upSpan.Minutes, $upSpan.Seconds
    $svc = Get-BridgeServiceStatus
    $sm = Get-StartMenuStatus
    $svcStr = if ($svc.installed) { "Installed ($($svc.taskName) - $($svc.state))" } else { "Not installed" }
    $smStr = if ($sm.installed) { "Installed ($($sm.shortcutCount) shortcuts)" } else { "Not installed" }
    $updStr = "Not checked yet"
    if ($script:LastUpdateResult) {
        if ($script:LastUpdateResult.ok) {
            if ($script:LastUpdateResult.updateAvailable) {
                $updStr = "UPDATE AVAILABLE: v$($script:LastUpdateResult.remoteVersion) (checked $($script:LastUpdateResult.checkedAt))"
            } else {
                $updStr = "Up to date (v$($script:AppVersion), checked $($script:LastUpdateResult.checkedAt))"
            }
        } else {
            $updStr = "Check failed ($($script:LastUpdateResult.error))"
        }
    }
    $bridgeState = if ($script:IsPaused) { "PAUSED" } else { "RUNNING" }
    $lastCmdStr = if ($script:LastCommandTime) { "$($script:LastCommand) at $($script:LastCommandTime.ToString('HH:mm:ss'))" } else { "None" }
    $httpSt = Get-HttpGatewayStatus
    $httpStr = if (-not $httpSt.enabled) {
        "Disabled"
    } elseif ($httpSt.listening) {
        "LISTENING ($($httpSt.mode), PID $($httpSt.pid)) | $($httpSt.url)"
    } else {
        "$($httpSt.mode.ToUpperInvariant()) ($($httpSt.lastError))"
    }

    $lines = @(
        "Bridge Status : $bridgeState  (Uptime: $upStr, Poll: $($script:Config.pollIntervalMs) ms)",
        "HTTP MCP      : $httpStr",
        "Requests      : $($script:RequestCount) OK / $($script:ErrorCount) errors  |  Last: $lastCmdStr",
        "TopSolid      : $tsInfo",
        "Service       : $svcStr",
        "Start Menu    : $smStr",
        "GitHub Update : $updStr",
        "IPC Folder    : $($script:IpcDir)",
        "Templates Dir : $($script:TemplatesDir)",
        "Config File   : $($script:ConfigPath)"
    )
    $script:InfoUI.txtStatus.Text = ($lines -join "`r`n")
    $newLog = ($script:LogLines -join "`r`n")
    if ($script:InfoUI.txtLog.Text -ne $newLog) {
        $script:InfoUI.txtLog.Text = $newLog
        $script:InfoUI.txtLog.SelectionStart = $script:InfoUI.txtLog.Text.Length
        $script:InfoUI.txtLog.ScrollToCaret()
    }
}

function Show-InfoWindow {
    if ($null -ne $script:InfoForm -and -not $script:InfoForm.IsDisposed) {
        $script:InfoForm.WindowState = [System.Windows.Forms.FormWindowState]::Normal
        $script:InfoForm.Activate()
        $script:InfoForm.BringToFront()
        Update-InfoWindowUI $false
        return
    }

    $form = New-Object System.Windows.Forms.Form
    $form.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::None
    $form.Text = "TopSolid MCP Bridge - Information"
    $form.ClientSize = New-Object System.Drawing.Size((S 620), (S 520))
    $form.MinimumSize = New-Object System.Drawing.Size((S 580), (S 480))
    $form.StartPosition = "CenterScreen"
    $form.Font = New-Object System.Drawing.Font("Segoe UI", 9.5)
    $form.Icon = Get-AppWindowIcon
    $form.BackColor = [System.Drawing.Color]::FromArgb(248, 250, 252)

    # Header bar
    $hdr = New-Object System.Windows.Forms.Panel
    $hdr.Dock = "Top"
    $hdr.Height = (S 66)
    $hdr.BackColor = [System.Drawing.Color]::FromArgb(24, 62, 120)
    $form.Controls.Add($hdr)

    $lblTitle = New-Object System.Windows.Forms.Label
    $lblTitle.Text = "TopSolid MCP Bridge"
    $lblTitle.ForeColor = [System.Drawing.Color]::White
    $lblTitle.Font = New-Object System.Drawing.Font("Segoe UI", 13, [System.Drawing.FontStyle]::Bold)
    $lblTitle.Location = New-Object System.Drawing.Point((S 16), (S 10))
    $lblTitle.AutoSize = $true
    $hdr.Controls.Add($lblTitle)

    $lblSub = New-Object System.Windows.Forms.Label
    $lblSub.Text = "Version $($script:AppVersion)  |  PID $PID  |  Shared-Folder IPC + COM Automation"
    $lblSub.ForeColor = [System.Drawing.Color]::FromArgb(191, 219, 254)
    $lblSub.Font = New-Object System.Drawing.Font("Segoe UI", 8.5)
    $lblSub.Location = New-Object System.Drawing.Point((S 18), (S 40))
    $lblSub.AutoSize = $true
    $hdr.Controls.Add($lblSub)

    # Status summary box
    $txtStatus = New-Object System.Windows.Forms.TextBox
    $txtStatus.Multiline = $true
    $txtStatus.ReadOnly = $true
    $txtStatus.ScrollBars = "Vertical"
    $txtStatus.BackColor = [System.Drawing.Color]::White
    $txtStatus.Font = New-Object System.Drawing.Font("Consolas", 9.0)
    $txtStatus.Location = New-Object System.Drawing.Point((S 16), (S 80))
    $txtStatus.Size = New-Object System.Drawing.Size((S 588), (S 194))
    $txtStatus.Anchor = "Top,Left,Right"
    $form.Controls.Add($txtStatus)

    # Activity Log label + box
    $lblLog = New-Object System.Windows.Forms.Label
    $lblLog.Text = "Recent Activity Log:"
    $lblLog.Font = New-Object System.Drawing.Font("Segoe UI", 9.0, [System.Drawing.FontStyle]::Bold)
    $lblLog.Location = New-Object System.Drawing.Point((S 16), (S 282))
    $lblLog.AutoSize = $true
    $form.Controls.Add($lblLog)

    $txtLog = New-Object System.Windows.Forms.TextBox
    $txtLog.Multiline = $true
    $txtLog.ReadOnly = $true
    $txtLog.ScrollBars = "Both"
    $txtLog.WordWrap = $false
    $txtLog.BackColor = [System.Drawing.Color]::FromArgb(15, 23, 42)
    $txtLog.ForeColor = [System.Drawing.Color]::FromArgb(226, 232, 240)
    $txtLog.Font = New-Object System.Drawing.Font("Consolas", 8.5)
    $txtLog.Location = New-Object System.Drawing.Point((S 16), (S 306))
    $txtLog.Size = New-Object System.Drawing.Size((S 588), (S 154))
    $txtLog.Anchor = "Top,Bottom,Left,Right"
    $form.Controls.Add($txtLog)

    # Bottom action buttons
    $btnRefresh = New-Object System.Windows.Forms.Button
    $btnRefresh.Text = "Refresh COM"
    $btnRefresh.Size = New-Object System.Drawing.Size((S 110), (S 34))
    $btnRefresh.Location = New-Object System.Drawing.Point((S 16), (S 472))
    $btnRefresh.Anchor = "Bottom,Left"
    $btnRefresh.Add_Click({ Update-InfoWindowUI $true })
    $form.Controls.Add($btnRefresh)

    $btnCopyMcp = New-Object System.Windows.Forms.Button
    $btnCopyMcp.Text = "Copy MCP Config"
    $btnCopyMcp.Size = New-Object System.Drawing.Size((S 132), (S 34))
    $btnCopyMcp.Location = New-Object System.Drawing.Point((S 134), (S 472))
    $btnCopyMcp.Anchor = "Bottom,Left"
    $btnCopyMcp.Add_Click({
        $serverPath = (Join-Path $script:RepoRoot "server\index.mjs") -replace '\\', '/'
        $rtNode = Join-Path $script:RepoRoot "runtime\node.exe"
        $nodeCmd = "node"
        if (Test-Path $rtNode) {
            $nodeCmd = $rtNode -replace '\\', '/'
        } else {
            $nc = Get-Command node -ErrorAction SilentlyContinue
            if ($nc -and $nc.Source) { $nodeCmd = $nc.Source -replace '\\', '/' }
        }
        $snippet = @"
{
  "mcpServers": {
    "topsolid6": {
      "command": "$nodeCmd",
      "args": ["$serverPath"],
      "disabled": false
    }
  }
}
"@
        [System.Windows.Forms.Clipboard]::SetText($snippet)
        Show-TrayBalloon "MCP Config Copied" "Copied topsolid6 mcp_config.json snippet to clipboard." "Info"
    })
    $form.Controls.Add($btnCopyMcp)

    $btnUpdates = New-Object System.Windows.Forms.Button
    $btnUpdates.Text = "Check Updates"
    $btnUpdates.Size = New-Object System.Drawing.Size((S 118), (S 34))
    $btnUpdates.Location = New-Object System.Drawing.Point((S 274), (S 472))
    $btnUpdates.Anchor = "Bottom,Left"
    $btnUpdates.Add_Click({
        Show-UpdateCheckDialog $false
        Update-InfoWindowUI $false
    })
    $form.Controls.Add($btnUpdates)

    $btnSettings = New-Object System.Windows.Forms.Button
    $btnSettings.Text = "Settings..."
    $btnSettings.Size = New-Object System.Drawing.Size((S 98), (S 34))
    $btnSettings.Location = New-Object System.Drawing.Point((S 400), (S 472))
    $btnSettings.Anchor = "Bottom,Left"
    $btnSettings.Add_Click({ Show-SettingsWindow })
    $form.Controls.Add($btnSettings)

    $btnClose = New-Object System.Windows.Forms.Button
    $btnClose.Text = "Close"
    $btnClose.Size = New-Object System.Drawing.Size((S 98), (S 34))
    $btnClose.Location = New-Object System.Drawing.Point((S 506), (S 472))
    $btnClose.Anchor = "Bottom,Right"
    $btnClose.Add_Click({
        if ($null -ne $script:InfoForm -and -not $script:InfoForm.IsDisposed) { $script:InfoForm.Close() }
    })
    $form.Controls.Add($btnClose)

    $script:InfoUI = @{
        txtStatus = $txtStatus
        txtLog    = $txtLog
    }
    $script:InfoForm = $form

    $script:InfoTimer = New-Object System.Windows.Forms.Timer
    $script:InfoTimer.Interval = 2000
    $script:InfoTimer.Add_Tick({ Update-InfoWindowUI $false })

    $form.Add_Shown({
        Update-InfoWindowUI $false
        if ($script:InfoTimer) { $script:InfoTimer.Start() }
    })
    $form.Add_FormClosed({
        if ($script:InfoTimer) {
            $script:InfoTimer.Stop()
            $script:InfoTimer.Dispose()
            $script:InfoTimer = $null
        }
        $script:InfoForm = $null
        $script:InfoUI = $null
    })
    $form.Show()
}

# ============================================================================
# Right-Click -> Settings Window
# ============================================================================
function Update-SettingsWinStatus {
    if ($null -eq $script:SettingsUI -or $null -eq $script:SettingsForm -or $script:SettingsForm.IsDisposed) { return }
    $svc = Get-BridgeServiceStatus
    $sm = Get-StartMenuStatus
    $script:SettingsUI.lblSvcStatus.Text = if ($svc.installed) { "Service: Installed (At Logon)" } else { "Service: Not installed" }
    $script:SettingsUI.lblSvcStatus.ForeColor = if ($svc.installed) { [System.Drawing.Color]::FromArgb(21, 128, 61) } else { [System.Drawing.Color]::FromArgb(100, 116, 139) }
    $script:SettingsUI.btnSvcRemove.Enabled = [bool]$svc.installed

    $script:SettingsUI.lblSmStatus.Text = if ($sm.installed) { "Start Menu: Installed ($($sm.shortcutCount) items)" } else { "Start Menu: Not installed" }
    $script:SettingsUI.lblSmStatus.ForeColor = if ($sm.installed) { [System.Drawing.Color]::FromArgb(21, 128, 61) } else { [System.Drawing.Color]::FromArgb(100, 116, 139) }
    $script:SettingsUI.btnSmRemove.Enabled = [bool]$sm.installed
}

function Show-SettingsWindow {
    if ($null -ne $script:SettingsForm -and -not $script:SettingsForm.IsDisposed) {
        $script:SettingsForm.WindowState = [System.Windows.Forms.FormWindowState]::Normal
        $script:SettingsForm.Activate()
        $script:SettingsForm.BringToFront()
        Update-SettingsWinStatus
        return
    }

    $form = New-Object System.Windows.Forms.Form
    $form.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::None
    $form.AutoScroll = $true
    $form.Text = "TopSolid MCP Bridge - Settings"
    $form.ClientSize = New-Object System.Drawing.Size((S 580), (S 650))
    $form.FormBorderStyle = "FixedDialog"
    $form.MaximizeBox = $false
    $form.StartPosition = "CenterScreen"
    $form.Font = New-Object System.Drawing.Font("Segoe UI", 9.5)
    $form.Icon = Get-AppWindowIcon
    $form.BackColor = [System.Drawing.Color]::FromArgb(248, 250, 252)

    # --- Group 1: Paths & Bridge ---
    $grpBridge = New-Object System.Windows.Forms.GroupBox
    $grpBridge.Text = "Bridge, Paths & TopSolid Version"
    $grpBridge.Location = New-Object System.Drawing.Point((S 14), (S 12))
    $grpBridge.Size = New-Object System.Drawing.Size((S 532), (S 230))
    $form.Controls.Add($grpBridge)

    $lblIpc = New-Object System.Windows.Forms.Label
    $lblIpc.Text = "IPC Folder:"
    $lblIpc.Location = New-Object System.Drawing.Point((S 12), (S 30))
    $lblIpc.Size = New-Object System.Drawing.Size((S 100), (S 24))
    $grpBridge.Controls.Add($lblIpc)

    $txtIpc = New-Object System.Windows.Forms.TextBox
    $txtIpc.Text = $script:Config.ipcDir
    $txtIpc.Location = New-Object System.Drawing.Point((S 116), (S 27))
    $txtIpc.Size = New-Object System.Drawing.Size((S 314), (S 26))
    $grpBridge.Controls.Add($txtIpc)

    $btnBrowseIpc = New-Object System.Windows.Forms.Button
    $btnBrowseIpc.Text = "Browse..."
    $btnBrowseIpc.Location = New-Object System.Drawing.Point((S 438), (S 25))
    $btnBrowseIpc.Size = New-Object System.Drawing.Size((S 82), (S 28))
    $btnBrowseIpc.Add_Click({
        $fbd = New-Object System.Windows.Forms.FolderBrowserDialog
        $fbd.SelectedPath = $script:SettingsUI.txtIpc.Text
        if ($fbd.ShowDialog() -eq "OK") { $script:SettingsUI.txtIpc.Text = $fbd.SelectedPath }
        $fbd.Dispose()
    })
    $grpBridge.Controls.Add($btnBrowseIpc)

    $lblTpl = New-Object System.Windows.Forms.Label
    $lblTpl.Text = "Templates Dir:"
    $lblTpl.Location = New-Object System.Drawing.Point((S 12), (S 66))
    $lblTpl.Size = New-Object System.Drawing.Size((S 100), (S 24))
    $grpBridge.Controls.Add($lblTpl)

    $txtTpl = New-Object System.Windows.Forms.TextBox
    $txtTpl.Text = $script:Config.templatesDir
    $txtTpl.Location = New-Object System.Drawing.Point((S 116), (S 63))
    $txtTpl.Size = New-Object System.Drawing.Size((S 314), (S 26))
    $grpBridge.Controls.Add($txtTpl)

    $btnBrowseTpl = New-Object System.Windows.Forms.Button
    $btnBrowseTpl.Text = "Browse..."
    $btnBrowseTpl.Location = New-Object System.Drawing.Point((S 438), (S 61))
    $btnBrowseTpl.Size = New-Object System.Drawing.Size((S 82), (S 28))
    $btnBrowseTpl.Add_Click({
        $fbd = New-Object System.Windows.Forms.FolderBrowserDialog
        $fbd.SelectedPath = $script:SettingsUI.txtTpl.Text
        if ($fbd.ShowDialog() -eq "OK") { $script:SettingsUI.txtTpl.Text = $fbd.SelectedPath }
        $fbd.Dispose()
    })
    $grpBridge.Controls.Add($btnBrowseTpl)

    $lblTsVer = New-Object System.Windows.Forms.Label
    $lblTsVer.Text = "TopSolid Ver:"
    $lblTsVer.Location = New-Object System.Drawing.Point((S 12), (S 102))
    $lblTsVer.Size = New-Object System.Drawing.Size((S 100), (S 24))
    $grpBridge.Controls.Add($lblTsVer)

    $cmbTsVer = New-Object System.Windows.Forms.ComboBox
    $cmbTsVer.DropDownStyle = [System.Windows.Forms.ComboBoxStyle]::DropDown
    $cmbTsVer.Location = New-Object System.Drawing.Point((S 116), (S 99))
    $cmbTsVer.Size = New-Object System.Drawing.Size((S 314), (S 26))
    [void]$cmbTsVer.Items.Add("Auto (Active COM / Newest)")
    $tsList = @(Get-InstalledTopSolidVersions)
    foreach ($it in $tsList) { [void]$cmbTsVer.Items.Add($it.exePath) }
    if ($script:Config.topsolidExe) {
        $idxFound = $cmbTsVer.Items.IndexOf($script:Config.topsolidExe)
        if ($idxFound -ge 0) { $cmbTsVer.SelectedIndex = $idxFound } else { $cmbTsVer.Text = $script:Config.topsolidExe }
    } else {
        $cmbTsVer.SelectedIndex = 0
    }
    $grpBridge.Controls.Add($cmbTsVer)

    $btnBrowseTs = New-Object System.Windows.Forms.Button
    $btnBrowseTs.Text = "Browse..."
    $btnBrowseTs.Location = New-Object System.Drawing.Point((S 438), (S 97))
    $btnBrowseTs.Size = New-Object System.Drawing.Size((S 82), (S 28))
    $btnBrowseTs.Add_Click({
        $ofd = New-Object System.Windows.Forms.OpenFileDialog
        $ofd.Filter = "TopSolid Executable (top6*.exe)|top6*.exe|Executable (*.exe)|*.exe"
        $ofd.Title = "Select TopSolid'Wood 6.xx Executable"
        if ($ofd.ShowDialog() -eq "OK") { $script:SettingsUI.cmbTsVer.Text = $ofd.FileName }
        $ofd.Dispose()
    })
    $grpBridge.Controls.Add($btnBrowseTs)

    $btnRebuildTpl = New-Object System.Windows.Forms.Button
    $btnRebuildTpl.Text = "Rebuild Templates (B&&S_*.top)..."
    $btnRebuildTpl.Location = New-Object System.Drawing.Point((S 116), (S 136))
    $btnRebuildTpl.Size = New-Object System.Drawing.Size((S 240), (S 30))
    $btnRebuildTpl.Add_Click({
        $selExe = $script:SettingsUI.cmbTsVer.Text.Trim()
        if ($selExe -like "Auto*") { $selExe = "" }
        Invoke-RebuildTemplates $script:SettingsUI.txtTpl.Text.Trim() $selExe
    })
    $grpBridge.Controls.Add($btnRebuildTpl)

    $lblPoll = New-Object System.Windows.Forms.Label
    $lblPoll.Text = "Poll Interval (ms):"
    $lblPoll.Location = New-Object System.Drawing.Point((S 12), (S 182))
    $lblPoll.Size = New-Object System.Drawing.Size((S 116), (S 24))
    $grpBridge.Controls.Add($lblPoll)

    $numPoll = New-Object System.Windows.Forms.NumericUpDown
    $numPoll.Minimum = 30
    $numPoll.Maximum = 2000
    $numPoll.Increment = 10
    $numPoll.Value = [Math]::Min(2000, [Math]::Max(30, [int]$script:Config.pollIntervalMs))
    $numPoll.Location = New-Object System.Drawing.Point((S 132), (S 179))
    $numPoll.Size = New-Object System.Drawing.Size((S 84), (S 26))
    $grpBridge.Controls.Add($numPoll)

    $chkNotif = New-Object System.Windows.Forms.CheckBox
    $chkNotif.Text = "Show tray balloon notifications"
    $chkNotif.Checked = [bool]$script:Config.showNotifications
    $chkNotif.Location = New-Object System.Drawing.Point((S 232), (S 181))
    $chkNotif.AutoSize = $true
    $grpBridge.Controls.Add($chkNotif)

    # --- Group 2: GitHub Updates ---
    $grpGit = New-Object System.Windows.Forms.GroupBox
    $grpGit.Text = "GitHub Updates"
    $grpGit.Location = New-Object System.Drawing.Point((S 14), (S 252))
    $grpGit.Size = New-Object System.Drawing.Size((S 532), (S 136))
    $form.Controls.Add($grpGit)

    $lblRepo = New-Object System.Windows.Forms.Label
    $lblRepo.Text = "GitHub Repo:"
    $lblRepo.Location = New-Object System.Drawing.Point((S 12), (S 30))
    $lblRepo.Size = New-Object System.Drawing.Size((S 100), (S 24))
    $grpGit.Controls.Add($lblRepo)

    $txtRepo = New-Object System.Windows.Forms.TextBox
    $txtRepo.Text = $script:Config.githubRepo
    $txtRepo.Location = New-Object System.Drawing.Point((S 116), (S 27))
    $txtRepo.Size = New-Object System.Drawing.Size((S 236), (S 26))
    $grpGit.Controls.Add($txtRepo)

    $lblBranch = New-Object System.Windows.Forms.Label
    $lblBranch.Text = "Branch:"
    $lblBranch.Location = New-Object System.Drawing.Point((S 362), (S 30))
    $lblBranch.Size = New-Object System.Drawing.Size((S 58), (S 24))
    $grpGit.Controls.Add($lblBranch)

    $txtBranch = New-Object System.Windows.Forms.TextBox
    $txtBranch.Text = $script:Config.githubBranch
    $txtBranch.Location = New-Object System.Drawing.Point((S 424), (S 27))
    $txtBranch.Size = New-Object System.Drawing.Size((S 96), (S 26))
    $grpGit.Controls.Add($txtBranch)

    $chkAutoUpd = New-Object System.Windows.Forms.CheckBox
    $chkAutoUpd.Text = "Automatically check for updates on startup"
    $chkAutoUpd.Checked = [bool]$script:Config.autoCheckUpdates
    $chkAutoUpd.Location = New-Object System.Drawing.Point((S 14), (S 62))
    $chkAutoUpd.AutoSize = $true
    $grpGit.Controls.Add($chkAutoUpd)

    $btnCheckNow = New-Object System.Windows.Forms.Button
    $btnCheckNow.Text = "Check for Updates Now"
    $btnCheckNow.Location = New-Object System.Drawing.Point((S 14), (S 92))
    $btnCheckNow.Size = New-Object System.Drawing.Size((S 180), (S 32))
    $btnCheckNow.Add_Click({
        $script:Config.githubRepo = $script:SettingsUI.txtRepo.Text.Trim()
        $script:Config.githubBranch = $script:SettingsUI.txtBranch.Text.Trim()
        Show-UpdateCheckDialog $false
    })
    $grpGit.Controls.Add($btnCheckNow)

    $btnOpenGit = New-Object System.Windows.Forms.Button
    $btnOpenGit.Text = "Open GitHub Repo"
    $btnOpenGit.Location = New-Object System.Drawing.Point((S 204), (S 92))
    $btnOpenGit.Size = New-Object System.Drawing.Size((S 150), (S 32))
    $btnOpenGit.Add_Click({
        Start-Process ("https://github.com/" + $script:SettingsUI.txtRepo.Text.Trim())
    })
    $grpGit.Controls.Add($btnOpenGit)

    # --- Group 3: Windows Service & Start Menu ---
    $grpWin = New-Object System.Windows.Forms.GroupBox
    $grpWin.Text = "Windows Integration (Service & Start Menu)"
    $grpWin.Location = New-Object System.Drawing.Point((S 14), (S 398))
    $grpWin.Size = New-Object System.Drawing.Size((S 532), (S 126))
    $form.Controls.Add($grpWin)

    $lblSvcStatus = New-Object System.Windows.Forms.Label
    $lblSvcStatus.Location = New-Object System.Drawing.Point((S 14), (S 32))
    $lblSvcStatus.Size = New-Object System.Drawing.Size((S 256), (S 24))
    $grpWin.Controls.Add($lblSvcStatus)

    $btnSvcInstall = New-Object System.Windows.Forms.Button
    $btnSvcInstall.Text = "Install as Service"
    $btnSvcInstall.Location = New-Object System.Drawing.Point((S 278), (S 26))
    $btnSvcInstall.Size = New-Object System.Drawing.Size((S 122), (S 32))
    $grpWin.Controls.Add($btnSvcInstall)

    $btnSvcRemove = New-Object System.Windows.Forms.Button
    $btnSvcRemove.Text = "Uninstall"
    $btnSvcRemove.Location = New-Object System.Drawing.Point((S 408), (S 26))
    $btnSvcRemove.Size = New-Object System.Drawing.Size((S 110), (S 32))
    $grpWin.Controls.Add($btnSvcRemove)

    $lblSmStatus = New-Object System.Windows.Forms.Label
    $lblSmStatus.Location = New-Object System.Drawing.Point((S 14), (S 78))
    $lblSmStatus.Size = New-Object System.Drawing.Size((S 256), (S 24))
    $grpWin.Controls.Add($lblSmStatus)

    $btnSmInstall = New-Object System.Windows.Forms.Button
    $btnSmInstall.Text = "Add Start Menu"
    $btnSmInstall.Location = New-Object System.Drawing.Point((S 278), (S 72))
    $btnSmInstall.Size = New-Object System.Drawing.Size((S 122), (S 32))
    $grpWin.Controls.Add($btnSmInstall)

    $btnSmRemove = New-Object System.Windows.Forms.Button
    $btnSmRemove.Text = "Remove"
    $btnSmRemove.Location = New-Object System.Drawing.Point((S 408), (S 72))
    $btnSmRemove.Size = New-Object System.Drawing.Size((S 110), (S 32))
    $grpWin.Controls.Add($btnSmRemove)

    $btnSvcInstall.Add_Click({
        try {
            Install-BridgeService
            Update-SettingsWinStatus
            Show-TrayBalloon "Service Installed" "TopSolid MCP Bridge will now start automatically at Windows logon." "Info"
        } catch {
            [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, "Service Error", "OK", "Error") | Out-Null
        }
    })
    $btnSvcRemove.Add_Click({
        try {
            Uninstall-BridgeService
            Update-SettingsWinStatus
            Show-TrayBalloon "Service Removed" "TopSolid MCP Bridge autostart service has been removed." "Info"
        } catch {
            [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, "Service Error", "OK", "Error") | Out-Null
        }
    })
    $btnSmInstall.Add_Click({
        try {
            Install-StartMenuShortcuts
            Update-SettingsWinStatus
            Show-TrayBalloon "Start Menu Added" "Created 'TopSolid MCP' folder in Start Menu." "Info"
        } catch {
            [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, "Start Menu Error", "OK", "Error") | Out-Null
        }
    })
    $btnSmRemove.Add_Click({
        try {
            Uninstall-StartMenuShortcuts
            Update-SettingsWinStatus
            Show-TrayBalloon "Start Menu Removed" "Removed 'TopSolid MCP' folder from Start Menu." "Info"
        } catch {
            [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, "Start Menu Error", "OK", "Error") | Out-Null
        }
    })

    # --- Group 4: Network (HTTP MCP) ---
    $grpNet = New-Object System.Windows.Forms.GroupBox
    $grpNet.Text = "Network (HTTP MCP Streamable Gateway)"
    $grpNet.Location = New-Object System.Drawing.Point((S 14), (S 534))
    $grpNet.Size = New-Object System.Drawing.Size((S 532), (S 182))
    $form.Controls.Add($grpNet)

    $chkHttpEnabled = New-Object System.Windows.Forms.CheckBox
    $chkHttpEnabled.Text = "Enable HTTP MCP Gateway"
    $chkHttpEnabled.Checked = [bool]$script:Config.httpEnabled
    $chkHttpEnabled.Location = New-Object System.Drawing.Point((S 14), (S 26))
    $chkHttpEnabled.AutoSize = $true
    $grpNet.Controls.Add($chkHttpEnabled)

    $lblHttpHost = New-Object System.Windows.Forms.Label
    $lblHttpHost.Text = "Host:"
    $lblHttpHost.Location = New-Object System.Drawing.Point((S 228), (S 28))
    $lblHttpHost.Size = New-Object System.Drawing.Size((S 40), (S 22))
    $grpNet.Controls.Add($lblHttpHost)

    $txtHttpHost = New-Object System.Windows.Forms.TextBox
    $txtHttpHost.Text = [string]$script:Config.httpHost
    $txtHttpHost.Location = New-Object System.Drawing.Point((S 270), (S 25))
    $txtHttpHost.Size = New-Object System.Drawing.Size((S 104), (S 24))
    $grpNet.Controls.Add($txtHttpHost)

    $lblHttpPort = New-Object System.Windows.Forms.Label
    $lblHttpPort.Text = "Port:"
    $lblHttpPort.Location = New-Object System.Drawing.Point((S 384), (S 28))
    $lblHttpPort.Size = New-Object System.Drawing.Size((S 38), (S 22))
    $grpNet.Controls.Add($lblHttpPort)

    $numHttpPort = New-Object System.Windows.Forms.NumericUpDown
    $numHttpPort.Minimum = 1024
    $numHttpPort.Maximum = 65535
    $numHttpPort.Value = [Math]::Min(65535, [Math]::Max(1024, [int]$script:Config.httpPort))
    $numHttpPort.Location = New-Object System.Drawing.Point((S 424), (S 25))
    $numHttpPort.Size = New-Object System.Drawing.Size((S 94), (S 24))
    $grpNet.Controls.Add($numHttpPort)

    $lblTok = New-Object System.Windows.Forms.Label
    $lblTok.Text = "Bearer Token:"
    $lblTok.Location = New-Object System.Drawing.Point((S 14), (S 64))
    $lblTok.Size = New-Object System.Drawing.Size((S 98), (S 22))
    $grpNet.Controls.Add($lblTok)

    $txtHttpToken = New-Object System.Windows.Forms.TextBox
    $txtHttpToken.Text = [string]$script:Config.httpToken
    $txtHttpToken.UseSystemPasswordChar = $true
    $txtHttpToken.ReadOnly = $true
    $txtHttpToken.Location = New-Object System.Drawing.Point((S 116), (S 61))
    $txtHttpToken.Size = New-Object System.Drawing.Size((S 184), (S 24))
    $grpNet.Controls.Add($txtHttpToken)

    $btnShowTok = New-Object System.Windows.Forms.Button
    $btnShowTok.Text = "Show"
    $btnShowTok.Location = New-Object System.Drawing.Point((S 306), (S 59))
    $btnShowTok.Size = New-Object System.Drawing.Size((S 58), (S 28))
    $btnShowTok.Add_Click({
        $t = $script:SettingsUI.txtHttpToken
        $t.UseSystemPasswordChar = (-not $t.UseSystemPasswordChar)
        $script:SettingsUI.btnShowTok.Text = if ($t.UseSystemPasswordChar) { "Show" } else { "Hide" }
    })
    $grpNet.Controls.Add($btnShowTok)

    $btnCopyTok = New-Object System.Windows.Forms.Button
    $btnCopyTok.Text = "Copy"
    $btnCopyTok.Location = New-Object System.Drawing.Point((S 368), (S 59))
    $btnCopyTok.Size = New-Object System.Drawing.Size((S 58), (S 28))
    $btnCopyTok.Add_Click({
        try { [System.Windows.Forms.Clipboard]::SetText($script:SettingsUI.txtHttpToken.Text) } catch {}
        Show-TrayBalloon "Token Copied" "Bearer token copied to clipboard." "Info"
    })
    $grpNet.Controls.Add($btnCopyTok)

    $btnRegenTok = New-Object System.Windows.Forms.Button
    $btnRegenTok.Text = "Regenerate"
    $btnRegenTok.Location = New-Object System.Drawing.Point((S 430), (S 59))
    $btnRegenTok.Size = New-Object System.Drawing.Size((S 88), (S 28))
    $btnRegenTok.Add_Click({
        $script:SettingsUI.txtHttpToken.Text = New-RandomHttpToken
    })
    $grpNet.Controls.Add($btnRegenTok)

    $lblAllow = New-Object System.Windows.Forms.Label
    $lblAllow.Text = "Allow IPs:"
    $lblAllow.Location = New-Object System.Drawing.Point((S 14), (S 100))
    $lblAllow.Size = New-Object System.Drawing.Size((S 98), (S 22))
    $grpNet.Controls.Add($lblAllow)

    $txtHttpAllow = New-Object System.Windows.Forms.TextBox
    $txtHttpAllow.Text = (@($script:Config.httpAllowFrom) -join ", ")
    $txtHttpAllow.Location = New-Object System.Drawing.Point((S 116), (S 97))
    $txtHttpAllow.Size = New-Object System.Drawing.Size((S 402), (S 24))
    $grpNet.Controls.Add($txtHttpAllow)

    $btnCopyClientCfg = New-Object System.Windows.Forms.Button
    $btnCopyClientCfg.Text = "Copy Client Config (Mac / Windows / stdio)"
    $btnCopyClientCfg.Location = New-Object System.Drawing.Point((S 116), (S 134))
    $btnCopyClientCfg.Size = New-Object System.Drawing.Size((S 310), (S 32))
    $btnCopyClientCfg.Add_Click({
        $script:Config.httpPort = [int]$script:SettingsUI.numHttpPort.Value
        $script:Config.httpToken = $script:SettingsUI.txtHttpToken.Text.Trim()
        try { [System.Windows.Forms.Clipboard]::SetText((Build-ClientConfigText)) } catch {}
        Show-TrayBalloon "Client Config Copied" "Ready-to-use Claude Code / MCP client configs copied to clipboard." "Info"
    })
    $grpNet.Controls.Add($btnCopyClientCfg)

    # --- Save / Cancel ---
    $btnSave = New-Object System.Windows.Forms.Button
    $btnSave.Text = "Save & Apply"
    $btnSave.Location = New-Object System.Drawing.Point((S 326), (S 728))
    $btnSave.Size = New-Object System.Drawing.Size((S 112), (S 34))
    $btnSave.Add_Click({
        $script:Config.ipcDir = $script:SettingsUI.txtIpc.Text.Trim()
        $script:Config.templatesDir = $script:SettingsUI.txtTpl.Text.Trim()
        $selExe = $script:SettingsUI.cmbTsVer.Text.Trim()
        $script:Config.topsolidExe = if ($selExe -like "Auto*") { "" } else { $selExe }
        $script:Config.pollIntervalMs = [int]$script:SettingsUI.numPoll.Value
        $script:Config.githubRepo = $script:SettingsUI.txtRepo.Text.Trim()
        $script:Config.githubBranch = $script:SettingsUI.txtBranch.Text.Trim()
        $script:Config.autoCheckUpdates = [bool]$script:SettingsUI.chkAutoUpd.Checked
        $script:Config.showNotifications = [bool]$script:SettingsUI.chkNotif.Checked
        $script:Config.httpEnabled = [bool]$script:SettingsUI.chkHttpEnabled.Checked
        $script:Config.httpHost = $script:SettingsUI.txtHttpHost.Text.Trim()
        $script:Config.httpPort = [int]$script:SettingsUI.numHttpPort.Value
        $script:Config.httpToken = $script:SettingsUI.txtHttpToken.Text.Trim()
        $allowRaw = $script:SettingsUI.txtHttpAllow.Text.Split(",") | ForEach-Object { $_.Trim() } | Where-Object { $_ }
        if (@($allowRaw).Count -gt 0) { $script:Config.httpAllowFrom = @($allowRaw) }
        Save-BridgeConfig $script:Config

        $script:IpcDir = $script:Config.ipcDir
        $script:TemplatesDir = $script:Config.templatesDir
        if (-not (Test-Path $script:IpcDir)) { New-Item -ItemType Directory -Path $script:IpcDir -Force | Out-Null }
        if ($script:IpcTimer) { $script:IpcTimer.Interval = $script:Config.pollIntervalMs }
        Start-HttpGateway
        Write-BridgeLog "Settings saved and applied (poll=$($script:Config.pollIntervalMs)ms, httpEnabled=$($script:Config.httpEnabled), port=$($script:Config.httpPort))."
        Show-TrayBalloon "Settings Saved" "Bridge & HTTP gateway configuration updated." "Info"
        if ($null -ne $script:SettingsForm -and -not $script:SettingsForm.IsDisposed) { $script:SettingsForm.Close() }
    })
    $form.Controls.Add($btnSave)

    $btnCancel = New-Object System.Windows.Forms.Button
    $btnCancel.Text = "Cancel"
    $btnCancel.Location = New-Object System.Drawing.Point((S 446), (S 728))
    $btnCancel.Size = New-Object System.Drawing.Size((S 100), (S 34))
    $btnCancel.Add_Click({
        if ($null -ne $script:SettingsForm -and -not $script:SettingsForm.IsDisposed) { $script:SettingsForm.Close() }
    })
    $form.Controls.Add($btnCancel)

    $script:SettingsUI = @{
        txtIpc         = $txtIpc
        txtTpl         = $txtTpl
        cmbTsVer       = $cmbTsVer
        numPoll        = $numPoll
        chkNotif       = $chkNotif
        txtRepo        = $txtRepo
        txtBranch      = $txtBranch
        chkAutoUpd     = $chkAutoUpd
        lblSvcStatus   = $lblSvcStatus
        btnSvcRemove   = $btnSvcRemove
        lblSmStatus    = $lblSmStatus
        btnSmRemove    = $btnSmRemove
        chkHttpEnabled = $chkHttpEnabled
        txtHttpHost    = $txtHttpHost
        numHttpPort    = $numHttpPort
        txtHttpToken   = $txtHttpToken
        btnShowTok     = $btnShowTok
        txtHttpAllow   = $txtHttpAllow
    }
    $script:SettingsForm = $form

    $form.Add_Shown({ Update-SettingsWinStatus })
    $form.Add_FormClosed({
        $script:SettingsForm = $null
        $script:SettingsUI = $null
    })
    $form.Show()
}

# ============================================================================
# Build System Tray Context Menu & NotifyIcon
# ============================================================================
$menu = New-Object System.Windows.Forms.ContextMenuStrip

$miSettings = New-Object System.Windows.Forms.ToolStripMenuItem("Settings...")
$miSettings.Font = New-Object System.Drawing.Font($miSettings.Font, [System.Drawing.FontStyle]::Bold)
$miSettings.Add_Click({ Show-SettingsWindow })

$miInfo = New-Object System.Windows.Forms.ToolStripMenuItem("Information & Status...")
$miInfo.Add_Click({ Show-InfoWindow })

$miPause = New-Object System.Windows.Forms.ToolStripMenuItem("Pause Bridge")
$miPause.Add_Click({
    $script:IsPaused = -not $script:IsPaused
    $miPause.Text = if ($script:IsPaused) { "Resume Bridge" } else { "Pause Bridge" }
    Update-TrayVisuals
    Write-BridgeLog (if ($script:IsPaused) { "Bridge paused by user." } else { "Bridge resumed by user." })
})

$miRestart = New-Object System.Windows.Forms.ToolStripMenuItem("Restart Bridge")
$miRestart.Add_Click({ Restart-BridgeProcess })

$miUpdate = New-Object System.Windows.Forms.ToolStripMenuItem("Check for Updates (GitHub)...")
$miUpdate.Add_Click({ Show-UpdateCheckDialog $false })

$miRebuildTpl = New-Object System.Windows.Forms.ToolStripMenuItem("Rebuild Templates (B&&S_*.top)...")
$miRebuildTpl.Add_Click({ Invoke-RebuildTemplates $script:TemplatesDir $script:Config.topsolidExe })

$miService = New-Object System.Windows.Forms.ToolStripMenuItem("Install as Service (Autostart)")
$miService.Add_Click({
    $svc = Get-BridgeServiceStatus
    try {
        if ($svc.installed) {
            Uninstall-BridgeService
            Show-TrayBalloon "Service Removed" "Removed TopSolid MCP autostart service." "Info"
        } else {
            Install-BridgeService
            Show-TrayBalloon "Service Installed" "Installed TopSolid MCP autostart service (At Logon)." "Info"
        }
    } catch {
        [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, "Service Error", "OK", "Error") | Out-Null
    }
})

$miStartMenu = New-Object System.Windows.Forms.ToolStripMenuItem("Add Start Menu Section")
$miStartMenu.Add_Click({
    $sm = Get-StartMenuStatus
    try {
        if ($sm.installed) {
            Uninstall-StartMenuShortcuts
            Show-TrayBalloon "Start Menu Removed" "Removed 'TopSolid MCP' folder from Start Menu." "Info"
        } else {
            Install-StartMenuShortcuts
            Show-TrayBalloon "Start Menu Added" "Added 'TopSolid MCP' folder to Start Menu." "Info"
        }
    } catch {
        [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, "Start Menu Error", "OK", "Error") | Out-Null
    }
})

$miKillStale = New-Object System.Windows.Forms.ToolStripMenuItem("Kill stale gateway (admin)")
$miKillStale.Visible = $false
$miKillStale.Add_Click({
    $targetPid = $script:HttpBlockedPid
    if ($targetPid -le 0) {
        $li = Get-PortListenerInfo ([int]$script:Config.httpPort)
        if ($li) { $targetPid = [int]$li.pid }
    }
    if ($targetPid -le 0) {
        Show-TrayBalloon "HTTP Gateway" "No blocking process found on port $($script:Config.httpPort)." "Info"
        return
    }
    try {
        Start-Process -FilePath "taskkill.exe" -ArgumentList "/PID $targetPid /T /F" -Verb RunAs -Wait
        $script:HttpBackoffSec = 3
        $script:HttpNextCheckAt = [DateTime]::MinValue
        Start-HttpGateway
        Show-TrayBalloon "Stale Gateway Killed" "Terminated PID $targetPid and restarted HTTP gateway." "Info"
    } catch {
        [System.Windows.Forms.MessageBox]::Show("Elevated kill failed: $($_.Exception.Message)", "Kill Stale Gateway", "OK", "Error") | Out-Null
    }
})

$miOpenIpc = New-Object System.Windows.Forms.ToolStripMenuItem("Open IPC Folder")
$miOpenIpc.Add_Click({ Start-Process "explorer.exe" $script:IpcDir })

$miOpenLog = New-Object System.Windows.Forms.ToolStripMenuItem("Open Log File")
$miOpenLog.Add_Click({
    if (-not (Test-Path $script:LogPath)) { [System.IO.File]::WriteAllText($script:LogPath, "", $script:Utf8NoBom) }
    Start-Process "notepad.exe" $script:LogPath
})

$miExit = New-Object System.Windows.Forms.ToolStripMenuItem("Exit")
$miExit.Add_Click({
    Write-BridgeLog "Exiting TopSolid MCP Bridge."
    if ($script:IpcTimer) { $script:IpcTimer.Stop() }
    if ($script:NotifyIcon) { $script:NotifyIcon.Visible = $false; $script:NotifyIcon.Dispose() }
    [System.Windows.Forms.Application]::Exit()
})

$menu.Add_Opening({
    $svc = Get-BridgeServiceStatus
    $miService.Checked = [bool]$svc.installed
    $miService.Text = if ($svc.installed) { "Service Installed (click to remove)" } else { "Install as Service (Autostart)" }

    $sm = Get-StartMenuStatus
    $miStartMenu.Checked = [bool]$sm.installed
    $miStartMenu.Text = if ($sm.installed) { "Start Menu Installed (click to remove)" } else { "Add Start Menu Section" }

    $miKillStale.Visible = ($script:HttpMode -eq "blocked" -and $script:HttpBlockedPid -gt 0)
    if ($miKillStale.Visible) {
        $miKillStale.Text = "Kill stale gateway PID $($script:HttpBlockedPid) (admin)"
    }
})

[void]$menu.Items.Add($miSettings)
[void]$menu.Items.Add($miInfo)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void]$menu.Items.Add($miPause)
[void]$menu.Items.Add($miRestart)
[void]$menu.Items.Add($miKillStale)
[void]$menu.Items.Add($miRebuildTpl)
[void]$menu.Items.Add($miUpdate)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void]$menu.Items.Add($miService)
[void]$menu.Items.Add($miStartMenu)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void]$menu.Items.Add($miOpenIpc)
[void]$menu.Items.Add($miOpenLog)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void]$menu.Items.Add($miExit)

$script:NotifyIcon = New-Object System.Windows.Forms.NotifyIcon
$script:NotifyIcon.ContextMenuStrip = $menu
$script:NotifyIcon.Visible = $true
Update-TrayVisuals

# Left-click -> Info window; Right-click -> ContextMenuStrip (Settings & Actions)
$script:NotifyIcon.Add_MouseClick({
    param($sender, $e)
    if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
        Show-InfoWindow
    }
})

# ============================================================================
# Timers: IPC Queue, Status Refresh, Startup Update Check
# ============================================================================
$script:IpcTimer = New-Object System.Windows.Forms.Timer
$script:IpcTimer.Interval = [Math]::Max(30, [int]$script:Config.pollIntervalMs)
$script:IpcTimer.Add_Tick({
    $script:IpcTimer.Stop()
    try {
        # Check single-instance remote UI commands
        if (Test-Path $script:UiCmdPath) {
            try {
                $cmdRaw = [System.IO.File]::ReadAllText($script:UiCmdPath, [System.Text.Encoding]::UTF8)
                Remove-Item $script:UiCmdPath -Force -ErrorAction SilentlyContinue
                $uiCmd = $cmdRaw | ConvertFrom-Json
                if ($uiCmd.action -eq "open_settings") { Show-SettingsWindow }
                elseif ($uiCmd.action -eq "check_update") { Show-UpdateCheckDialog $false }
                else { Show-InfoWindow }
            } catch {}
        }
        Process-IpcQueue
    } finally {
        $script:IpcTimer.Start()
    }
})
$script:IpcTimer.Start()

$statusTimer = New-Object System.Windows.Forms.Timer
$statusTimer.Interval = 5000
$statusTimer.Add_Tick({
    Ensure-HttpGatewayAlive
    Update-TrayVisuals
})
$statusTimer.Start()

Start-HttpGateway

if ($script:Config.autoCheckUpdates) {
    $updTimer = New-Object System.Windows.Forms.Timer
    $updTimer.Interval = 6000
    $updTimer.Add_Tick({
        $updTimer.Stop()
        $updTimer.Dispose()
        try {
            $res = Test-GitHubUpdate
            if ($res.ok -and $res.updateAvailable) {
                Show-TrayBalloon "TopSolid MCP Update Available" "v$($res.remoteVersion) is available on GitHub (current: v$($res.localVersion)). Right-click tray icon -> Check for Updates." "Info"
            }
        } catch {}
    })
    $updTimer.Start()
}

Write-BridgeLog "TopSolid MCP Bridge v$($script:AppVersion) started (Tray mode, IPC=$($script:IpcDir))."
Show-TrayBalloon "TopSolid MCP Bridge v$($script:AppVersion)" "Running in system tray. Left-click for Info, right-click for Settings." "Info"

if ($OpenSettings) { Show-SettingsWindow }
elseif ($OpenInfo) { Show-InfoWindow }
elseif ($CheckUpdate) { Show-UpdateCheckDialog $false }

$appContext = New-Object System.Windows.Forms.ApplicationContext
try {
    [System.Windows.Forms.Application]::Run($appContext)
} finally {
    Stop-HttpGateway
    if ($script:CurrentTrayIconHandle -ne [IntPtr]::Zero) {
        [Ts6Win32]::DestroyIcon($script:CurrentTrayIconHandle) | Out-Null
    }
    if ($script:NotifyIcon) { $script:NotifyIcon.Visible = $false; $script:NotifyIcon.Dispose() }
    if ($script:Mutex) {
        try { $script:Mutex.ReleaseMutex() } catch {}
        $script:Mutex.Dispose()
    }
}
