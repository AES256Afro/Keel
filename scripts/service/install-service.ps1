# Installs Keel as a Windows scheduled task that starts automatically and
# keeps running - including after a reboot. Run from the project folder:
#
#   npm run service:install
#
# By default the task starts when you sign in (no admin rights needed).
# To start at boot even before anyone signs in, run from an ADMIN PowerShell:
#
#   powershell -ExecutionPolicy Bypass -File scripts\service\install-service.ps1 -AtStartup
#
# Options:  -Port 3000   change the port Keel listens on

param(
    [int]$Port = 3000,
    [switch]$AtStartup
)

$ErrorActionPreference = "Stop"
$taskName = "Keel"
$project = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$runner = Join-Path $project "scripts\service\start-keel.ps1"

$action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runner`" -Port $Port" `
    -WorkingDirectory $project

$settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

if ($AtStartup) {
    # Boot-time start (requires an elevated PowerShell); runs as SYSTEM so no
    # user needs to be signed in.
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
        -Settings $settings -Principal $principal -Force | Out-Null
} else {
    # Starts whenever you sign in - no admin rights required.
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
        -Settings $settings -Force | Out-Null
}

Start-ScheduledTask -TaskName $taskName

Write-Host ""
Write-Host "✔ Keel installed as scheduled task '$taskName' and started."
Write-Host "  It will start automatically $(if ($AtStartup) { 'at boot' } else { 'when you sign in' }) and restart itself if it crashes."
Write-Host "  Open:      http://localhost:$Port"
Write-Host "  Logs:      $project\logs\service.log"
Write-Host "  Uninstall: npm run service:uninstall"
