<#
.SYNOPSIS
  Remove the Windows Startup shortcut for rokibrain.app.

.DESCRIPTION
  Idempotent: silently succeeds when nothing is installed.

.EXAMPLE
  pwsh -NoProfile -File .\uninstall-autostart.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$startupDir   = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
$shortcutPath = Join-Path $startupDir 'rokibrain.lnk'

if (Test-Path -LiteralPath $shortcutPath) {
  Remove-Item -LiteralPath $shortcutPath -Force
  Write-Host "[uninstall-autostart] removed $shortcutPath"
} else {
  Write-Host "[uninstall-autostart] no shortcut at $shortcutPath (ok)."
}

Write-Host "[uninstall-autostart] done."
