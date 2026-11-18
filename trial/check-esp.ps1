param(
  [string]$EspIp = "",
  [int]$TimeoutSec = 3
)

# Quick check of the Hydronode ESP32 HTTP API before a trial.
# Usage: powershell -ExecutionPolicy Bypass -File .\check-esp.ps1 -EspIp 192.168.1.50

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$settingsPath = Join-Path $root "banyu\settings.env"

function Normalize-Base([string]$v) {
  $v = ($v -as [string]).Trim()
  if (-not $v) { return "" }
  if ($v -notmatch '^https?://') { $v = "http://" + $v }
  return $v.TrimEnd('/')
}

$base = Normalize-Base $EspIp
if (-not $base -and (Test-Path $settingsPath)) {
  Get-Content $settingsPath | ForEach-Object {
    if ($_ -match '^\s*ESP32_BASE_URL\s*=\s*(.*?)\s*$') { $base = Normalize-Base $matches[1] }
  }
}
if (-not $base) {
  Write-Host "No ESP address. Pass -EspIp 192.168.x.x or set ESP32_BASE_URL in banyu/settings.env." -ForegroundColor Yellow
  exit 1
}

Write-Host "GET $base/api/status ..."
try {
  $j = Invoke-RestMethod -Uri "$base/api/status" -TimeoutSec $TimeoutSec
} catch {
  Write-Host "FAILED: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "Check: ESP and laptop on the same Wi-Fi, IP is correct, ESP is powered." -ForegroundColor DarkGray
  exit 1
}

Write-Host "OK" -ForegroundColor Green
Write-Host "  ip          : $($j.ip)"
Write-Host "  build       : $($j.build)"
Write-Host "  wifi        : $($j.wifi_status_name) / rssi $($j.rssi)"
Write-Host "  tank        : $($j.tank_state) (raw $($j.tank_raw), mode $($j.tank_pin_mode), filter $($j.tank_debounce_ms) ms)"
Write-Host "  job         : active=$($j.job_active) state=$($j.job_state) $($j.job_ml)/$($j.job_target_ml) ml"
Write-Host "  flow        : $($j.flow_lpm) L/min"
if ($j.tank_low) { Write-Host "Tank is LOW: refill before selling." -ForegroundColor Yellow }
