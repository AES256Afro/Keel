# Removes the Keel scheduled task and stops the running server.
#
#   npm run service:uninstall

$ErrorActionPreference = "SilentlyContinue"
$taskName = "Keel"
$project = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path

Stop-ScheduledTask -TaskName $taskName
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false

# Stop any Keel server processes the task left behind (matched by project path).
Get-CimInstance Win32_Process |
    Where-Object { $_.CommandLine -like "*next*start*" -and $_.CommandLine -like "*$project*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Get-CimInstance Win32_Process |
    Where-Object { $_.CommandLine -like "*start-keel.ps1*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

Write-Host "✔ Keel service removed. Your data (prisma\dev.db, backups) is untouched."
