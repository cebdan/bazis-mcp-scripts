# TopSolid MCP Prerequisite Installer & Agent Auto-Configurator
# Checks/installs Node.js LTS (>= 18) and registers topsolid6 in Antigravity mcp_config.json.

param(
    [string]$InstallDir = "",
    [switch]$EnsureNode,
    [switch]$ConfigureAntigravity,
    [switch]$VerifyMcp
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$utf8NoBom = New-Object System.Text.UTF8Encoding $false

if (-not $InstallDir) {
    $InstallDir = Split-Path -Parent $PSScriptRoot
}
$RuntimeDir = Join-Path $InstallDir "runtime"
$ServerScript = Join-Path $InstallDir "server\index.mjs"

function Get-NodeMajorVersion([string]$exePath) {
    if (-not (Test-Path $exePath)) { return 0 }
    try {
        $ver = (& $exePath -v 2>$null | Out-String).Trim()
        if ($ver -match '^v(\d+)\.') {
            return [int]$Matches[1]
        }
    } catch {}
    return 0
}

function Find-ExistingNode {
    $candidates = @()
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source) { $candidates += $cmd.Source }
    $candidates += "C:\Program Files\nodejs\node.exe"
    $candidates += "C:\Program Files (x86)\nodejs\node.exe"
    $candidates += (Join-Path $RuntimeDir "node.exe")
    $candidates += (Join-Path $env:LOCALAPPDATA "Programs\nodejs\node.exe")

    foreach ($p in ($candidates | Select-Object -Unique)) {
        $maj = Get-NodeMajorVersion $p
        if ($maj -ge 18) {
            $ver = (& $p -v 2>$null | Out-String).Trim()
            return @{ found = $true; path = $p; version = $ver; major = $maj }
        }
    }
    return @{ found = $false; path = ""; version = ""; major = 0 }
}

function Add-ToUserPath([string]$dirToAdd) {
    $cur = [Environment]::GetEnvironmentVariable("Path", "User")
    if (-not $cur) { $cur = "" }
    $parts = @($cur -split ';' | Where-Object { $_ -and $_.Trim() -ne "" })
    $norm = $dirToAdd.TrimEnd('\').ToLowerInvariant()
    $exists = $false
    foreach ($item in $parts) {
        if ($item.TrimEnd('\').ToLowerInvariant() -eq $norm) { $exists = $true; break }
    }
    if (-not $exists) {
        $newPath = ($parts + $dirToAdd) -join ';'
        [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
    }
    if (($env:Path -split ';') -notcontains $dirToAdd) {
        $env:Path = "$dirToAdd;$env:Path"
    }
}

function Install-PortableNodeLts {
    $verTag = "v22.14.0"
    try {
        $idx = Invoke-RestMethod -Uri "https://nodejs.org/dist/index.json" -TimeoutSec 12 -UseBasicParsing
        $lts = $idx | Where-Object { $_.lts -and $_.lts -ne $false -and ($_.files -contains "win-x64-zip") } | Select-Object -First 1
        if ($lts -and $lts.version) { $verTag = [string]$lts.version }
    } catch {}

    $zipName = "node-$verTag-win-x64.zip"
    $zipUrl = "https://nodejs.org/dist/$verTag/$zipName"
    $tmpZip = Join-Path $env:TEMP ("ts6_" + $zipName)
    $tmpExt = Join-Path $env:TEMP ("ts6_node_ext_" + [Guid]::NewGuid().ToString("N").Substring(0, 8))

    Write-Output "STATUS|Downloading Node.js LTS $verTag (win-x64 portable)..."
    Invoke-WebRequest -Uri $zipUrl -OutFile $tmpZip -TimeoutSec 120 -UseBasicParsing

    Write-Output "STATUS|Extracting Node.js LTS $verTag..."
    if (Test-Path $tmpExt) { Remove-Item $tmpExt -Recurse -Force -ErrorAction SilentlyContinue }
    Expand-Archive -Path $tmpZip -DestinationPath $tmpExt -Force
    Remove-Item $tmpZip -Force -ErrorAction SilentlyContinue

    $inner = Get-ChildItem -Path $tmpExt -Directory | Select-Object -First 1
    if (-not $inner) { throw "Unexpected Node.js archive layout." }

    if (Test-Path $RuntimeDir) {
        Remove-Item $RuntimeDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    Move-Item -Path $inner.FullName -Destination $RuntimeDir -Force
    Remove-Item $tmpExt -Recurse -Force -ErrorAction SilentlyContinue

    $nodeExe = Join-Path $RuntimeDir "node.exe"
    if (-not (Test-Path $nodeExe)) { throw "node.exe not found after extraction." }

    Add-ToUserPath $RuntimeDir
    $ver = (& $nodeExe -v 2>$null | Out-String).Trim()
    return @{ found = $true; path = $nodeExe; version = $ver; major = (Get-NodeMajorVersion $nodeExe) }
}

function Ensure-NodeRuntime {
    $info = Find-ExistingNode
    if ($info.found) {
        Write-Output ("NODE_OK|" + $info.version + "|" + $info.path)
        return $info
    }

    # Try winget first if available (fast system-wide install)
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if ($winget) {
        Write-Output "STATUS|Installing Node.js LTS via winget..."
        try {
            & winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-source-agreements --accept-package-agreements --silent 2>&1 | Out-Null
        } catch {}
        $info = Find-ExistingNode
        if ($info.found) {
            Add-ToUserPath (Split-Path -Parent $info.path)
            Write-Output ("NODE_OK|" + $info.version + "|" + $info.path)
            return $info
        }
    }

    # Fallback: official portable Node.js LTS (zero UAC, always works)
    $info = Install-PortableNodeLts
    Write-Output ("NODE_OK|" + $info.version + "|" + $info.path)
    return $info
}

function Update-McpJsonFile([string]$jsonPath, [string]$nodeExe, [string]$serverJs) {
    $dir = Split-Path -Parent $jsonPath
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

    $root = New-Object PSObject
    if (Test-Path $jsonPath) {
        try {
            $raw = [System.IO.File]::ReadAllText($jsonPath, [System.Text.Encoding]::UTF8)
            if ($raw.Trim()) {
                $parsed = $raw | ConvertFrom-Json
                if ($null -ne $parsed) { $root = $parsed }
            }
        } catch {
            # Backup malformed JSON before overwriting
            Copy-Item $jsonPath ($jsonPath + ".bak") -Force -ErrorAction SilentlyContinue
        }
    }

    if (-not ($root.PSObject.Properties.Name -contains "mcpServers") -or $null -eq $root.mcpServers) {
        $root | Add-Member -MemberType NoteProperty -Name "mcpServers" -Value (New-Object PSObject) -Force
    }

    $entry = [ordered]@{
        command  = $nodeExe
        args     = @($serverJs)
        disabled = $false
    }
    if ($root.mcpServers.PSObject.Properties.Name -contains "topsolid6") {
        $root.mcpServers.topsolid6 = $entry
    } else {
        $root.mcpServers | Add-Member -MemberType NoteProperty -Name "topsolid6" -Value $entry -Force
    }

    $outJson = $root | ConvertTo-Json -Depth 10
    [System.IO.File]::WriteAllText($jsonPath, $outJson + "`r`n", $utf8NoBom)
    Write-Output ("MCP_CONFIG_OK|" + $jsonPath)
}

$nodeInfo = Find-ExistingNode
if ($EnsureNode) {
    $nodeInfo = Ensure-NodeRuntime
}

if ($ConfigureAntigravity) {
    $nodeCmd = if ($nodeInfo.found) { $nodeInfo.path } else { "node" }
    $agyConfig = Join-Path $env:USERPROFILE ".gemini\antigravity\mcp_config.json"
    Update-McpJsonFile $agyConfig $nodeCmd $ServerScript

    # Also update .gemini\config\mcp_config.json if it exists as a separate file
    $altConfig = Join-Path $env:USERPROFILE ".gemini\config\mcp_config.json"
    if (Test-Path $altConfig) {
        $sameFile = $false
        try {
            $i1 = Get-Item $agyConfig -ErrorAction SilentlyContinue
            $i2 = Get-Item $altConfig -ErrorAction SilentlyContinue
            if ($i1 -and $i2 -and ($i1.Target -contains $altConfig)) { $sameFile = $true }
        } catch {}
        if (-not $sameFile) {
            Update-McpJsonFile $altConfig $nodeCmd $ServerScript
        }
    }
}

if ($VerifyMcp) {
    if (-not $nodeInfo.found) {
        throw "Node.js not found for MCP verification."
    }
    Start-Sleep -Milliseconds 1200
    $out = & $nodeInfo.path $ServerScript --info 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Output "VERIFY_OK|MCP server connected to TopSolid Bridge."
    } else {
        Write-Output ("VERIFY_WARN|" + (($out | Out-String).Trim()))
    }
}
