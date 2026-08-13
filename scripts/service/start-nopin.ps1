# Runs Keel in production mode: installs dependencies if missing, syncs the
# database schema, builds when there is no build yet, then starts the server -
# and restarts it automatically if it ever exits.
#
# This is the script the "Keel" scheduled task runs. You can also run it by
# hand:  powershell -ExecutionPolicy Bypass -File scripts\service\start-keel.ps1

param([int]$Port = 3000)

$ErrorActionPreference = "Continue"
$project = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location $project
$env:PORT = "$Port"
$env:NODE_ENV = "production"

$logDir = Join-Path $project "logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$logFile = Join-Path $logDir "service.log"

function Log($msg) {
    "$(Get-Date -Format s)  $msg" | Add-Content -Path $logFile
}

# Keep the log from growing forever.
if ((Test-Path $logFile) -and ((Get-Item $logFile).Length -gt 5MB)) {
    Move-Item -Force $logFile (Join-Path $logDir "service.old.log")
}

Log "=== Keel service starting (port $Port) ==="

if (-not (Test-Path (Join-Path $project "node_modules"))) {
    Log "node_modules missing - running npm install..."
    npm install --no-audit --no-fund *>> $logFile
}

if (-not (Test-Path (Join-Path $project ".env"))) {
    Copy-Item (Join-Path $project ".env.example") (Join-Path $project ".env")
    Log "Created .env from .env.example"
}

while ($true) {
    try {
        Log "Syncing database schema..."
        npx prisma db push *>> $logFile

        if (-not (Test-Path (Join-Path $project ".next\BUILD_ID"))) {
            Log "No production build found - building (this can take a minute)..."
            npm run build *>> $logFile
        }

        Log "Starting server on http://localhost:$Port"
        npx next start -p $Port *>> $logFile
        Log "Server exited (code $LASTEXITCODE)"
    }
    catch {
        Log "Error: $_"
    }
    Log "Restarting in 5 seconds..."
    Start-Sleep -Seconds 5
}
