<#
.SYNOPSIS
  One-time setup for Gabay SMS gateway phones, run from a PC over ADB.

.DESCRIPTION
  For every phone that `adb devices` lists (or only -Serial):
    1. optionally installs/updates the APK (-Apk),
    2. grants WRITE_SECURE_SETTINGS, so the app keeps Remote Screen switched on
       by itself and never needs anyone at the phone again,
    3. switches Remote Screen (accessibility service) on right away,
    4. raises Android's per-app SMS limit so the "sending a large number of SMS
       messages - Allow?" prompt stops blocking the outbox,
    5. optionally reboots (-Reboot) so the new SMS limit takes effect.

  Prepare each phone once: Settings > About phone > tap "Build number" 7 times,
  then Developer options > USB debugging ON (plus "USB debugging (Security
  settings)" on Xiaomi, or "Disable permission monitoring" on OPPO/realme).
  Plug it in and accept the "Allow USB debugging?" prompt on the phone.

.EXAMPLE
  .\provision-gateways.ps1 -Apk .\gabay-sms-2.8.24.apk -Reboot
#>
param(
  [string]$Apk,
  [string]$Serial,
  [switch]$Reboot,
  [int]$SmsLimit = 100000
)

$ErrorActionPreference = 'Stop'
$Package = 'sms.gabay.online'
$Service = "$Package/com.vernu.sms.remotescreen.RemoteScreenService"

if (-not (Get-Command adb -ErrorAction SilentlyContinue)) {
  throw 'adb not found. Install Android platform-tools and add it to PATH.'
}

function Invoke-Adb([string]$Device, [string[]]$Arguments) {
  # Windows PowerShell 5.1 turns native stderr into a terminating error under 'Stop'.
  $ErrorActionPreference = 'Continue'
  $output = & adb -s $Device @Arguments 2>&1 | Out-String
  return $output.Trim()
}

$devices = if ($Serial) { @($Serial) } else {
  & adb devices | Select-Object -Skip 1 |
    Where-Object { $_ -match '^\S+\s+device$' } |
    ForEach-Object { ($_ -split '\s+')[0] }
}
if (-not $devices) { throw 'No authorised phones found. Check the cable and accept the USB debugging prompt.' }

$results = foreach ($device in $devices) {
  $model = Invoke-Adb $device @('shell', 'getprop', 'ro.product.model')
  Write-Host "`n=== $model ($device) ===" -ForegroundColor Cyan
  $row = [ordered]@{ Phone = "$model ($device)"; App = ''; Grant = ''; RemoteScreen = ''; SmsLimit = '' }

  if ($Apk) {
    Write-Host 'Installing APK...'
    $install = Invoke-Adb $device @('install', '-r', $Apk)
    if ($install -notmatch 'Success') { Write-Warning $install }
  }
  $version = Invoke-Adb $device @('shell', 'dumpsys', 'package', $Package) |
    Select-String -Pattern 'versionName=(\S+)' | Select-Object -First 1
  if (-not $version) {
    Write-Warning 'Gabay SMS is not installed on this phone; skipping.'
    $row.App = 'not installed'; [pscustomobject]$row; continue
  }
  $row.App = $version.Matches[0].Groups[1].Value

  $grant = Invoke-Adb $device @('shell', 'pm', 'grant', $Package, 'android.permission.WRITE_SECURE_SETTINGS')
  $row.Grant = if ($grant) { "FAILED: $grant" } else { 'ok' }
  if ($grant) { Write-Warning "Grant failed (app older than 2.8.24, or OEM security option needed): $grant" }

  # Switch Remote Screen on now, keeping any other accessibility services.
  $sdk = [int](Invoke-Adb $device @('shell', 'getprop', 'ro.build.version.sdk'))
  if ($sdk -ge 30) {
    $current = Invoke-Adb $device @('shell', 'settings', 'get', 'secure', 'enabled_accessibility_services')
    $list = @($current -split ':' | Where-Object { $_ -and $_ -ne 'null' })
    if ($list -notcontains $Service) { $list += $Service }
    Invoke-Adb $device @('shell', 'settings', 'put', 'secure', 'enabled_accessibility_services', "'$($list -join ':')'") | Out-Null
    Invoke-Adb $device @('shell', 'settings', 'put', 'secure', 'accessibility_enabled', '1') | Out-Null
    $now = Invoke-Adb $device @('shell', 'settings', 'get', 'secure', 'enabled_accessibility_services')
    $row.RemoteScreen = if ($now -like "*$Service*") { 'on' } else { 'FAILED' }
  } else {
    $row.RemoteScreen = "n/a (Android SDK $sdk < 30)"
  }

  Invoke-Adb $device @('shell', 'settings', 'put', 'global', 'sms_outgoing_check_max_count', "$SmsLimit") | Out-Null
  $row.SmsLimit = Invoke-Adb $device @('shell', 'settings', 'get', 'global', 'sms_outgoing_check_max_count')

  if ($Reboot) {
    Write-Host 'Rebooting so the SMS limit takes effect...'
    Invoke-Adb $device @('reboot') | Out-Null
  }
  [pscustomobject]$row
}

Write-Host ''
$results | Format-Table -AutoSize
if (-not $Reboot) {
  Write-Host 'Restart each phone once (or re-run with -Reboot) so Android applies the new SMS limit.' -ForegroundColor Yellow
}
