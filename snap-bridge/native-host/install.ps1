<#
.SYNOPSIS
  Register (or remove) the Snap Studio native messaging host, so the KB tab's
  "Start bridge" button can launch snap-bridge/server.js.

.DESCRIPTION
  Chrome will only talk to a native host that is declared in TWO places, and
  it fails silently-ish if either is missing or stale:

    1. a manifest JSON on disk, naming the executable Chrome may launch and
       whitelisting the extension origins allowed to reach it;
    2. an HKCU registry value under the browser's NativeMessagingHosts key,
       whose (default) value is the ABSOLUTE path of that manifest.

  It also refuses to launch a .js/.mjs file directly on Windows, hence the
  small .cmd shim this script generates with an absolute node.exe path baked
  in (Chrome does not necessarily hand the host a useful PATH).

  The extension ID is the part people get wrong: an unpacked extension's ID is
  derived from the folder it was loaded from, so it differs per machine and
  changes if the repo moves. This script reads it out of Chrome's own profile
  data by matching the load path against this repo. Pass -ExtensionId to
  override, and re-run this script after moving the repo.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File snap-bridge\native-host\install.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File snap-bridge\native-host\install.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  [string]   $ExtensionId,
  [string]   $NodeExe,
  [string[]] $Browsers = @('Chrome', 'Edge'),
  [switch]   $Uninstall
)

$ErrorActionPreference = 'Stop'
$HostName   = 'com.snapstudio.bridge'
$HereDir    = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot   = (Resolve-Path (Join-Path $HereDir '..\..')).Path
$ManifestPath = Join-Path $HereDir "$HostName.json"
$ShimPath     = Join-Path $HereDir 'snap-bridge-host.cmd'
$HostScript   = Join-Path $HereDir 'snap-bridge-host.mjs'

$RegRoots = @{
  Chrome   = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts'
  Edge     = 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts'
  Chromium = 'HKCU:\Software\Chromium\NativeMessagingHosts'
}
$UserDataRoots = @{
  Chrome   = "$env:LOCALAPPDATA\Google\Chrome\User Data"
  Edge     = "$env:LOCALAPPDATA\Microsoft\Edge\User Data"
  Chromium = "$env:LOCALAPPDATA\Chromium\User Data"
}

# ---------------------------------------------------------------- uninstall
if ($Uninstall) {
  foreach ($b in $Browsers) {
    $key = Join-Path $RegRoots[$b] $HostName
    if (Test-Path $key) {
      Remove-Item $key -Recurse -Force
      Write-Output "removed registry key for $b"
    } else {
      Write-Output "no registry key for $b (nothing to do)"
    }
  }
  foreach ($f in @($ManifestPath, $ShimPath)) {
    if (Test-Path $f) { Remove-Item $f -Force; Write-Output "deleted $f" }
  }
  Write-Output ''
  Write-Output 'Uninstalled. The "Start bridge" button will now report that the host is not installed.'
  return
}

# ------------------------------------------------------------------- node
if (-not $NodeExe) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($null -eq $cmd) {
    throw 'node was not found on PATH. Re-run with -NodeExe "C:\path\to\node.exe".'
  }
  $NodeExe = $cmd.Source
}
if (-not (Test-Path $NodeExe)) { throw "node.exe not found at: $NodeExe" }
if (-not (Test-Path $HostScript)) { throw "host script missing: $HostScript" }

# ----------------------------------------------------------- extension id
# Unpacked extensions live in "Secure Preferences" on Chrome and "Preferences"
# on some builds; check both, in every profile, and match on the load path.
function Find-ExtensionId {
  param([string]$UserDataRoot, [string]$LoadPath)
  if (-not (Test-Path $UserDataRoot)) { return $null }
  $profiles = Get-ChildItem $UserDataRoot -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -eq 'Default' -or $_.Name -like 'Profile*' }
  foreach ($prof in $profiles) {
    foreach ($file in @('Secure Preferences', 'Preferences')) {
      $p = Join-Path $prof.FullName $file
      if (-not (Test-Path $p)) { continue }
      try { $json = Get-Content $p -Raw -Encoding UTF8 | ConvertFrom-Json } catch { continue }
      $settings = $json.extensions.settings
      if ($null -eq $settings) { continue }
      foreach ($entry in $settings.PSObject.Properties) {
        $ext = $entry.Value
        if (-not $ext.path) { continue }
        if (("$($ext.path)".TrimEnd('\')) -ieq $LoadPath.TrimEnd('\')) { return $entry.Name }
      }
    }
  }
  return $null
}

$ids = @()
if ($ExtensionId) {
  $ids += $ExtensionId
} else {
  foreach ($b in $Browsers) {
    $found = Find-ExtensionId -UserDataRoot $UserDataRoots[$b] -LoadPath $RepoRoot
    if ($found) {
      Write-Output "found Snap Studio in $b as $found"
      $ids += $found
    }
  }
  $ids = $ids | Select-Object -Unique
}
if ($ids.Count -eq 0) {
  throw @"
Could not find a browser profile with Snap Studio loaded unpacked from:
  $RepoRoot

Load the extension first (chrome://extensions -> Developer mode -> Load
unpacked -> pick that folder), then re-run this script. Or pass the ID shown
on that page directly:
  install.ps1 -ExtensionId <id>
"@
}

# ------------------------------------------------------------ write files
$shim = @"
@echo off
rem GENERATED by snap-bridge\native-host\install.ps1 -- re-run it after moving
rem the repo or changing node. Chrome cannot launch a .mjs directly, and does
rem not guarantee a usable PATH, so the interpreter is absolute here.
"$NodeExe" "$HostScript" %*
"@
Set-Content -Path $ShimPath -Value $shim -Encoding ASCII

$manifest = [ordered]@{
  name            = $HostName
  description     = 'Starts the Snap Studio snap-bridge server on request from the Snap Studio extension.'
  path            = $ShimPath
  type            = 'stdio'
  allowed_origins = @($ids | ForEach-Object { "chrome-extension://$_/" })
}
# NOT Set-Content -Encoding UTF8: on Windows PowerShell 5.1 that writes a BOM,
# and a native messaging manifest is JSON Chrome parses itself. Chromium does
# strip a leading BOM today, which is exactly the kind of thing to not depend
# on for a file that only gets read when something is already broken.
$json = $manifest | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText($ManifestPath, $json, (New-Object System.Text.UTF8Encoding($false)))

# --------------------------------------------------------------- registry
foreach ($b in $Browsers) {
  $root = $RegRoots[$b]
  if (-not (Test-Path $root)) { New-Item -Path $root -Force | Out-Null }
  $key = Join-Path $root $HostName
  if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
  Set-ItemProperty -Path $key -Name '(default)' -Value $ManifestPath
  Write-Output "registered for $b -> $key"
}

Write-Output ''
Write-Output "host script : $HostScript"
Write-Output "shim        : $ShimPath"
Write-Output "manifest    : $ManifestPath"
Write-Output "node        : $NodeExe"
Write-Output "extensions  : $($ids -join ', ')"
Write-Output ''
Write-Output 'Done. Reload Snap Studio at chrome://extensions (the nativeMessaging'
Write-Output 'permission is only picked up on reload), then open the KB tab and use'
Write-Output 'the Start bridge button.'
