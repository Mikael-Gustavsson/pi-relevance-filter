<#
.SYNOPSIS
  Setup for the Pi Relevance Filter extension (idempotent).

  1. Installs dev dependencies and typechecks the extension
  2. Registers this directory in ~/.pi/agent/settings.json (the filter stays OFF until PI_RELEVANCE_FILTER=1)
  3. Checks whether a Relevance Filter service answers on the configured URL

  The service itself is a separate project: https://github.com/Mikael-Gustavsson/relevance-filter

  Usage:  .\scripts\setup.ps1 [-SkipRegister]
#>
param([switch]$SkipRegister)
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }

Step "Dependencies and typecheck"
npm install --no-audit --no-fund --silent
npx tsc --noEmit -p .
if ($LASTEXITCODE) { throw "typecheck failed" }

if (-not $SkipRegister) {
    Step "Register extension in ~/.pi/agent/settings.json (disabled until PI_RELEVANCE_FILTER=1)"
    $settingsPath = Join-Path $HOME ".pi\agent\settings.json"
    $extPath = $Root -replace "\\", "/"
    $settings = if (Test-Path $settingsPath) { Get-Content $settingsPath -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }
    $list = @()
    if ($settings.PSObject.Properties.Name -contains "extensions") { $list = @($settings.extensions) }
    if ($list -notcontains $extPath) {
        Copy-Item $settingsPath "$settingsPath.bak" -ErrorAction SilentlyContinue
        $list += $extPath
        $settings | Add-Member -NotePropertyName extensions -NotePropertyValue $list -Force
        $json = $settings | ConvertTo-Json -Depth 20
        New-Item -ItemType Directory -Force -Path (Split-Path $settingsPath) | Out-Null
        [System.IO.File]::WriteAllText($settingsPath, $json, (New-Object System.Text.UTF8Encoding($false)))  # no BOM
        Write-Host "  added $extPath (backup: settings.json.bak)"
    } else { Write-Host "  already registered" }
}

Step "Relevance Filter service"
$url = if ($env:PI_RELEVANCE_FILTER_URL) { $env:PI_RELEVANCE_FILTER_URL } else { "http://127.0.0.1:8765" }
try {
    $h = Invoke-RestMethod "$url/v1/health" -TimeoutSec 3
    Write-Host "  $url answers: device $($h.device)"
} catch {
    Write-Host "  no service on $url. Install and start it: https://github.com/Mikael-Gustavsson/relevance-filter" -ForegroundColor Yellow
}

Write-Host "`nSetup complete. Next (with the service running):" -ForegroundColor Green
Write-Host "  `$env:PI_RELEVANCE_FILTER=`"1`"; pi"
