[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$installerPath = Join-Path $root "install.ps1"
$text = Get-Content -LiteralPath $installerPath -Raw
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
  $installerPath,
  [ref]$tokens,
  [ref]$parseErrors
)
if ($parseErrors) {
  throw "install.ps1 does not parse: $($parseErrors.Message -join '; ')"
}

$functionAst = $ast.Find({
  param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq "Set-KeelRestrictedAcl"
}, $true)
if (-not $functionAst) {
  throw "Set-KeelRestrictedAcl is missing from install.ps1"
}

$functionText = $functionAst.Extent.Text
$requiredFunctionPatterns = @(
  'SetAccessRuleProtection\(\$true,\s*\$false\)',
  'PurgeAccessRules',
  'SetOwner\(\$currentUserSid\)',
  'S-1-5-18',
  'S-1-5-32-544',
  'ReparsePoint',
  'AreAccessRulesProtected',
  'FileSystemRights\]::FullControl'
)
foreach ($pattern in $requiredFunctionPatterns) {
  if ($functionText -notmatch $pattern) {
    throw "Set-KeelRestrictedAcl is missing required control: $pattern"
  }
}

$dataCall = 'Set-KeelRestrictedAcl -Path $dataDir -Recurse'
$backupCall = 'Set-KeelRestrictedAcl -Path $backupDir -Recurse'
$dataCallAt = $text.IndexOf($dataCall, [System.StringComparison]::Ordinal)
$backupCallAt = $text.IndexOf($backupCall, [System.StringComparison]::Ordinal)
$envWriteAt = $text.IndexOf('Set-Content -Path $envFile', [System.StringComparison]::Ordinal)
$databaseCreateAt = $text.IndexOf('npm run db:deploy', [System.StringComparison]::Ordinal)
if ($dataCallAt -lt 0 -or $backupCallAt -lt 0) {
  throw "install.ps1 must recursively harden both data and backup directories"
}
if ($envWriteAt -lt 0 -or $databaseCreateAt -lt 0 -or
    $dataCallAt -gt $envWriteAt -or $backupCallAt -gt $envWriteAt -or
    $dataCallAt -gt $databaseCreateAt -or $backupCallAt -gt $databaseCreateAt) {
  throw "data ACL hardening must happen before secret or database creation"
}
if ($text -notmatch 'Refusing to continue') {
  throw "ACL failure must stop the installer with a clear error"
}

Write-Host "Static Windows installer ACL checks passed."

if ($env:OS -ne "Windows_NT") {
  Write-Host "Runtime ACL checks skipped because this runner is not Windows."
  exit 0
}

# Load only the helper under test. Dot-sourcing the installer would fetch and
# build Keel, which is outside the scope of this focused permissions test.
. ([ScriptBlock]::Create($functionText))

$scratch = Join-Path ([System.IO.Path]::GetTempPath()) ("keel-acl-" + [guid]::NewGuid().ToString("N"))
try {
  $data = Join-Path $scratch "data"
  $nested = Join-Path $data "existing"
  New-Item -ItemType Directory -Force -Path $nested | Out-Null
  New-Item -ItemType File -Force -Path (Join-Path $data "keel.db") | Out-Null
  New-Item -ItemType File -Force -Path (Join-Path $data ".keel-server-secrets.key") | Out-Null
  New-Item -ItemType File -Force -Path (Join-Path $nested "old-backup.enc") | Out-Null

  # Seed a broad legacy rule that the installer must remove from every item.
  $everyone = [System.Security.Principal.SecurityIdentifier]::new("S-1-1-0")
  foreach ($path in @($data, $nested, (Join-Path $data "keel.db"),
      (Join-Path $data ".keel-server-secrets.key"), (Join-Path $nested "old-backup.enc"))) {
    $item = Get-Item -LiteralPath $path -Force
    $acl = Get-Acl -LiteralPath $path
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
    if ($item -is [System.IO.DirectoryInfo]) {
      $inheritance = (
        [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
        [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
      )
    }
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
      $everyone,
      [System.Security.AccessControl.FileSystemRights]::ReadAndExecute,
      $inheritance,
      [System.Security.AccessControl.PropagationFlags]::None,
      [System.Security.AccessControl.AccessControlType]::Allow
    ))
    Set-Acl -LiteralPath $path -AclObject $acl
  }

  Set-KeelRestrictedAcl -Path $data -Recurse

  $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $allowed = @($currentSid, "S-1-5-18", "S-1-5-32-544") | Sort-Object -Unique
  foreach ($item in @(Get-Item -LiteralPath $data -Force) +
      @(Get-ChildItem -LiteralPath $data -Force -Recurse)) {
    $acl = Get-Acl -LiteralPath $item.FullName
    if (-not $acl.AreAccessRulesProtected) {
      throw "$($item.FullName) still inherits access rules"
    }
    $actual = @($acl.Access | ForEach-Object {
      $_.IdentityReference.Translate(
        [System.Security.Principal.SecurityIdentifier]
      ).Value
    } | Sort-Object -Unique)
    if (($actual -join ',') -ne ($allowed -join ',')) {
      throw "$($item.FullName) has unexpected identities: $($actual -join ', ')"
    }
  }

  $missingFailed = $false
  try {
    Set-KeelRestrictedAcl -Path (Join-Path $scratch "missing") -Recurse
  } catch {
    $missingFailed = $_.Exception.Message -match "Could not secure"
  }
  if (-not $missingFailed) {
    throw "a missing security target did not fail closed"
  }

  Write-Host "Runtime Windows installer ACL checks passed."
} finally {
  if (Test-Path -LiteralPath $scratch) {
    Remove-Item -LiteralPath $scratch -Recurse -Force
  }
}
