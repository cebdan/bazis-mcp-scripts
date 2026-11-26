<#
.SYNOPSIS
    Discovers installed TopSolid'Wood 6.xx versions and builds/rebuilds the 6 base
    B&S_*.top process templates natively in the chosen TopSolid version.
#>
param(
    [string]$TemplatesDir = "",
    [string]$TopSolidExe = "",
    [string]$SeedDir = "",
    [switch]$Force,
    [switch]$ListVersions,
    [switch]$PauseOnExit
)

$ErrorActionPreference = "Stop"

# --- Load default paths from %APPDATA%\TopSolid6MCP\config.json if omitted ---
$AppDataDir = Join-Path $env:APPDATA "TopSolid6MCP"
$ConfigPath = Join-Path $AppDataDir "config.json"
if (Test-Path $ConfigPath) {
    try {
        $cfg = [System.IO.File]::ReadAllText($ConfigPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
        if (-not $TemplatesDir -and $cfg.templatesDir) { $TemplatesDir = [string]$cfg.templatesDir }
        if (-not $TopSolidExe -and $cfg.topsolidExe) { $TopSolidExe = [string]$cfg.topsolidExe }
    } catch {}
}
if (-not $TemplatesDir) { $TemplatesDir = "C:\Missler\mcp\Templates" }

# --- Discover all installed TopSolid 6.xx versions on this PC ---
function Get-TopSolidInstallations {
    $found = New-Object System.Collections.Generic.List[object]
    $seen = @{}

    function Add-Candidate([string]$exePath) {
        if (-not $exePath) { return }
        $clean = $exePath.Trim().Trim('"')
        if (-not (Test-Path $clean)) { return }
        $key = $clean.ToLowerInvariant()
        if ($seen.ContainsKey($key)) { return }
        $seen[$key] = $true

        $ver = "6.xx"
        if ($clean -match 'V6(\d\d)') {
            $ver = "6." + $Matches[1]
        } elseif ($clean -match 'top6(\d\d)\.exe') {
            $ver = "6." + $Matches[1]
        }
        $found.Add([PSCustomObject]@{
            version = $ver
            exePath = $clean
            label   = "TopSolid $ver ($clean)"
        })
    }

    # 1. Standard Missler install roots across local drives
    $roots = @(
        "C:\Missler",
        "D:\Missler",
        "E:\Missler",
        "C:\Program Files\Missler",
        "C:\Program Files (x86)\Missler"
    )
    foreach ($root in $roots) {
        if (-not (Test-Path $root)) { continue }
        Get-ChildItem -Path $root -Directory -Filter "V6*" -ErrorAction SilentlyContinue | ForEach-Object {
            $binDir = Join-Path $_.FullName "bin"
            if (Test-Path $binDir) {
                Get-ChildItem -Path $binDir -File -Filter "top6*.exe" -ErrorAction SilentlyContinue | ForEach-Object {
                    Add-Candidate $_.FullName
                }
            }
        }
    }

    # 2. Registry COM LocalServer32 fallback
    $regPaths = @(
        "Registry::HKEY_CLASSES_ROOT\TopSolid.Application\CLSID"
    )
    foreach ($rp in $regPaths) {
        try {
            if (Test-Path $rp) {
                $clsid = (Get-ItemProperty -Path $rp -ErrorAction SilentlyContinue).'(default)'
                if ($clsid) {
                    $srv = (Get-ItemProperty -Path "Registry::HKEY_CLASSES_ROOT\CLSID\$clsid\LocalServer32" -ErrorAction SilentlyContinue).'(default)'
                    if ($srv) {
                        if ($srv -match '^"([^"]+\.exe)"') { Add-Candidate $Matches[1] }
                        elseif ($srv -match '^([^\s]+\.exe)') { Add-Candidate $Matches[1] }
                    }
                }
            }
        } catch {}
    }

    return @($found | Sort-Object -Property version -Descending)
}

if ($ListVersions) {
    $list = @(Get-TopSolidInstallations)
    if ($list.Count -eq 0) {
        Write-Output "[]"
    } else {
        Write-Output ($list | ConvertTo-Json -Compress)
    }
    exit 0
}

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host " TopSolid'Wood 6.xx Base Template Builder (B&S_*.top)" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "Templates Dir : $TemplatesDir"
Write-Host "Target Exe    : $(if ($TopSolidExe) { $TopSolidExe } else { 'Auto (Active COM / Newest)' })"
Write-Host "Force Rebuild : $Force"
Write-Host ""

if (-not (Test-Path $TemplatesDir)) {
    New-Item -ItemType Directory -Path $TemplatesDir -Force | Out-Null
}

# Clear cached exact-size variants on -Force so stale files from another TopSolid version never collide
$cacheDir = Join-Path $TemplatesDir "cache"
if ($Force -and (Test-Path $cacheDir)) {
    Write-Host "[1/3] Clearing stale template cache ($cacheDir)..."
    Get-ChildItem -Path $cacheDir -Filter "*.top*" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
}

# --- Ensure the requested TopSolid version is running ---
$targetExe = $TopSolidExe.Trim()
if ($targetExe -and -not (Test-Path $targetExe)) {
    Write-Host "[WARN] Configured TopSolid executable not found: $targetExe" -ForegroundColor Yellow
    $targetExe = ""
}

$runningTop = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '^top6\d\d$' })
if ($targetExe) {
    $sameRunning = $false
    foreach ($p in $runningTop) {
        try {
            if ($p.Path -and ($p.Path.ToLowerInvariant() -eq $targetExe.ToLowerInvariant())) {
                $sameRunning = $true
            }
        } catch {}
    }
    if (-not $sameRunning) {
        if ($runningTop.Count -gt 0) {
            Write-Host "[1/3] Closing other TopSolid version(s) before launching selected version..."
            $runningTop | Stop-Process -Force -ErrorAction SilentlyContinue
            Start-Sleep -Milliseconds 1200
        }
        Write-Host "[1/3] Launching $targetExe ..."
        Start-Process -FilePath $targetExe | Out-Null
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $ready = $false
        while ($sw.Elapsed.TotalSeconds -lt 45) {
            $procs = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '^top6\d\d$' -and $_.MainWindowHandle -ne 0 })
            if ($procs.Count -gt 0) {
                $ready = $true
                break
            }
            Start-Sleep -Milliseconds 300
        }
        if (-not $ready) {
            throw "Timed out waiting for TopSolid window ($targetExe)."
        }
        Start-Sleep -Milliseconds 2000
    }
} elseif ($runningTop.Count -eq 0) {
    $installed = @(Get-TopSolidInstallations)
    if ($installed.Count -gt 0) {
        $targetExe = $installed[0].exePath
        Write-Host "[1/3] Launching discovered TopSolid: $($installed[0].label) ..."
        Start-Process -FilePath $targetExe | Out-Null
        Start-Sleep -Seconds 4
    }
}

Write-Host "[2/3] Connecting to TopSolid.Application COM..."
$app = $null
for ($try = 0; $try -lt 10; $try++) {
    try {
        $app = New-Object -ComObject TopSolid.Application
        if ($null -ne $app) { break }
    } catch {}
    Start-Sleep -Milliseconds 700
}
if ($null -eq $app) {
    throw "Cannot connect to TopSolid.Application COM. Make sure TopSolid'Wood 6.xx is installed and licensed."
}
$tsVer = ""
try { $tsVer = [string]$app.Version } catch {}
Write-Host "      Connected to TopSolid COM (Version: $tsVer)" -ForegroundColor Green

# Optional seed directory (e.g. shared network templates) to regenerate & upgrade cleanly into this version
if (-not $SeedDir) {
    $seedCandidates = @(
        "Y:\Works\bazis\TopSolid_Templates",
        (Join-Path (Split-Path -Parent $PSScriptRoot) "Templates")
    )
    foreach ($sc in $seedCandidates) {
        if ((Test-Path $sc) -and ($sc.TrimEnd('\').ToLowerInvariant() -ne $TemplatesDir.TrimEnd('\').ToLowerInvariant())) {
            if (Test-Path (Join-Path $sc "B&S_Drill.top")) {
                $SeedDir = $sc
                break
            }
        }
    }
}

$specs = @(
    @{ file = "B&S_Drill.top";    des = "B&S Native Drill Template";     params = @(@("D", 0.008), @("H", 0.015)) },
    @{ file = "B&S_DrillRow.top"; des = "B&S Native Drill Row Template"; params = @(@("D", 0.005), @("H", 0.012), @("N", 3), @("Step", 0.032)) },
    @{ file = "B&S_Pocket.top";   des = "B&S Native Pocket Template";    params = @(@("W", 0.100), @("L", 0.200), @("H", 0.007)) },
    @{ file = "B&S_Groove.top";   des = "B&S Native Groove Template";    params = @(@("W", 0.0185), @("H", 0.0065), @("L", 0.100)) },
    @{ file = "B&S_Rabbet.top";   des = "B&S Native Rabbet Template";    params = @(@("W", 0.010), @("H", 0.010), @("L", 0.100)) },
    @{ file = "B&S_Moulding.top"; des = "B&S Native Moulding Template";  params = @(@("W", 0.010), @("H", 0.010), @("L", 0.100)) }
)

Write-Host "[3/3] Building 6 base B&S_*.top templates in $TemplatesDir ..."
$built = 0
$skipped = 0
$failed = 0

foreach ($sp in $specs) {
    $dst = Join-Path $TemplatesDir $sp.file
    if ((Test-Path $dst) -and (-not $Force)) {
        Write-Host "  [SKIP] $($sp.file) (already exists)" -ForegroundColor DarkGray
        $skipped++
        continue
    }

    $seedFile = if ($SeedDir) { Join-Path $SeedDir $sp.file } else { "" }
    try {
        if ($seedFile -and (Test-Path $seedFile)) {
            # Upgrade & regenerate seed template natively inside this TopSolid version
            Copy-Item -Path $seedFile -Destination $dst -Force
            $doc = $app.Documents.Open($dst)
            Start-Sleep -Milliseconds 200
            try { $doc.Document.Regenerate() | Out-Null } catch {}
            $doc.Document.Save() | Out-Null
            $doc.Document.Close($false, $false) | Out-Null
            Write-Host "  [OK]   $($sp.file) (regenerated natively in TopSolid $tsVer)" -ForegroundColor Green
            $built++
        } else {
            # Clean-room native template creation via TopSolid COM (Origin CS + DummyBlock + Driver Params)
            $doc = $app.Documents.Add("top")
            $cs = $doc.CoordinateSystems.AddBasic(0, 0, 0, 1, 0, 0, 0, 1, 0)
            $cs.Name = "Origin"
            $blk = $doc.Shapes.AddBasicBlock(0, 0, -0.02, 1, 0, 0, 0, 1, 0, 0.2, 0.2, 0.04)
            $blk.Name = "DummyBlock"
            $blk.Layer = 0
            foreach ($pr in $sp.params) {
                $pName = $pr[0]
                $pVal = $pr[1]
                try {
                    if ($pName -eq "N") {
                        $p = $doc.Parameters.AddInteger($pName, [int]$pVal)
                    } else {
                        $p = $doc.Parameters.AddLength($pName, [double]$pVal)
                    }
                    try { $p.Name = $pName } catch {}
                } catch {}
            }
            $docFile = $doc.Document
            try { $docFile.Designation = $sp.des } catch {}
            if (Test-Path $dst) { Remove-Item -Path $dst -Force -ErrorAction SilentlyContinue }
            $docFile.SaveAs($dst) | Out-Null
            $docFile.Close($false, $false) | Out-Null
            Write-Host "  [OK]   $($sp.file) (created via COM in TopSolid $tsVer)" -ForegroundColor Green
            $built++
        }
    } catch {
        Write-Host "  [ERR]  $($sp.file): $($_.Exception.Message)" -ForegroundColor Red
        $failed++
    }
}

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "Summary: Built=$built, Skipped=$skipped, Failed=$failed (TopSolid $tsVer)" -ForegroundColor Cyan
Write-Host "Folder : $TemplatesDir"
Write-Host "============================================================" -ForegroundColor Cyan
Write-Output "TEMPLATES_OK|built=$built|skipped=$skipped|failed=$failed|version=$tsVer"

if ($PauseOnExit) {
    Write-Host ""
    Read-Host "Press Enter to close"
}
if ($failed -gt 0) { exit 1 }
exit 0
