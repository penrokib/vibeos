<#
.SYNOPSIS
  Install Windows Startup shortcut for rokibrain.app.

.DESCRIPTION
  Creates rokibrain.lnk in the per-user Startup folder so rokibrain.exe
  launches hidden at sign-in. Uses the WScript.Shell COM object so no
  external dependencies are required.

  Idempotent: overwrites any existing shortcut at the same path.

.PARAMETER ExePath
  Optional override for the rokibrain.exe path. Defaults to
  "$env:ProgramFiles\rokibrain\rokibrain.exe".

.EXAMPLE
  pwsh -NoProfile -File .\install-autostart.ps1
  pwsh -NoProfile -File .\install-autostart.ps1 -ExePath 'C:\Tools\rokibrain\rokibrain.exe'
#>
[CmdletBinding()]
param(
  [string]$ExePath = (Join-Path $env:ProgramFiles 'rokibrain\rokibrain.exe')
)

$ErrorActionPreference = 'Stop'

$startupDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
$shortcutPath = Join-Path $startupDir 'rokibrain.lnk'

if (-not (Test-Path -LiteralPath $startupDir)) {
  New-Item -ItemType Directory -Path $startupDir -Force | Out-Null
}

if (-not (Test-Path -LiteralPath $ExePath)) {
  Write-Warning "rokibrain.exe not found at '$ExePath'. The shortcut will be created anyway; install rokibrain there or rerun with -ExePath."
}

# Remove any prior shortcut for idempotency.
if (Test-Path -LiteralPath $shortcutPath) {
  Remove-Item -LiteralPath $shortcutPath -Force
}

$wsh = New-Object -ComObject WScript.Shell
try {
  $shortcut = $wsh.CreateShortcut($shortcutPath)
  $shortcut.TargetPath       = $ExePath
  $shortcut.Arguments        = '--hidden'
  $shortcut.WorkingDirectory = Split-Path -Parent $ExePath
  $shortcut.Description      = 'rokibrain — autostart at sign-in'
  $shortcut.WindowStyle      = 7   # 7 = minimized; the app self-hides via --hidden
  $shortcut.Save()
}
finally {
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($wsh) | Out-Null
}

Write-Host "[install-autostart] Startup shortcut created: $shortcutPath"
Write-Host "[install-autostart] Target: $ExePath --hidden"
Write-Host "[install-autostart] Verify: Get-Item -LiteralPath '$shortcutPath'"
