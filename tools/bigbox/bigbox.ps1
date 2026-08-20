# Launcher for the bigbox CLI (PowerShell). Put this directory on your PATH.
& node "$PSScriptRoot/bigbox.mjs" @args
exit $LASTEXITCODE
