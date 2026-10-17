<#
  ReadyUSB release script (for the developer; not shipped on the drive).

  Reads VERSION from viewer/app.js, checks README.txt and CHANGELOG.md match, tags the current
  commit as v<version>, builds dist/ReadyUSB-<version>.zip with `git archive` (files listed in
  .gitattributes as export-ignore are left out) and publishes a GitHub release with the zip.

  Usage (from the repo root, in Windows PowerShell):
    powershell -ExecutionPolicy Bypass -File tools\make-release.ps1
    powershell -ExecutionPolicy Bypass -File tools\make-release.ps1 -ZipOnly   # build the zip, no tag or release
#>
param([switch]$ZipOnly)

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

function Fail($msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }

# --- Version, and the files that must agree with it
$app = Get-Content 'viewer/app.js' -Raw
$m = [regex]::Match($app, "var VERSION = '([0-9]+\.[0-9]+\.[0-9]+)';")
if (-not $m.Success) { Fail "Couldn't find VERSION in viewer/app.js." }
$version = $m.Groups[1].Value
$tag = "v$version"
Write-Host "ReadyUSB $version"

if (-not (Select-String -Path 'README.txt' -SimpleMatch "(version $version)" -Quiet)) {
  Fail "README.txt doesn't say (version $version)."
}
$changelog = Get-Content 'CHANGELOG.md' -Raw -Encoding UTF8
$section = [regex]::Match($changelog, "(?ms)^## $([regex]::Escape($version))\b[^\n]*\n(.*?)(?=^## |\z)")
if (-not $section.Success) { Fail "CHANGELOG.md has no '## $version' section." }

# --- Build the zip from a commit, so it holds exactly what's committed
New-Item -ItemType Directory -Force 'dist' | Out-Null
$zip = "dist/ReadyUSB-$version.zip"
if (Test-Path $zip) { Remove-Item $zip }

if ($ZipOnly) {
  git archive --format=zip -o $zip HEAD
  if ($LASTEXITCODE -ne 0) { Fail 'git archive failed.' }
  Write-Host "Built $zip from HEAD (no tag, no release)."
  exit 0
}

# --- Release checks
if (git status --porcelain) { Fail 'There are uncommitted changes. Commit them first.' }
$branch = (git rev-parse --abbrev-ref HEAD).Trim()
if ($branch -ne 'main') { Fail "Releases are made from main (current branch: $branch)." }
git fetch -q origin
if ((git rev-parse HEAD).Trim() -ne (git rev-parse origin/main).Trim()) { Fail 'main is not in step with origin/main. Push or pull first.' }
if (git tag -l $tag) { Fail "Tag $tag already exists. Bump VERSION for a new release." }

$gh = Get-Command gh -ErrorAction SilentlyContinue
if ($gh) { $gh = $gh.Source } elseif (Test-Path "$env:ProgramFiles\GitHub CLI\gh.exe") { $gh = "$env:ProgramFiles\GitHub CLI\gh.exe" }
else { Fail 'GitHub CLI (gh) not found.' }

# --- Tag, build, publish
git tag -a $tag -m "ReadyUSB $version"
git archive --format=zip -o $zip $tag
if ($LASTEXITCODE -ne 0) { Fail 'git archive failed.' }
git push -q origin $tag

$notes = Join-Path $env:TEMP "readyusb-notes-$version.md"
$section.Groups[1].Value.Trim() | Out-File -FilePath $notes -Encoding utf8
& $gh release create $tag $zip --title "ReadyUSB $version" --notes-file $notes
if ($LASTEXITCODE -ne 0) { Fail 'gh release create failed. The tag is pushed; rerun the release step by hand.' }
Remove-Item $notes

Write-Host "Released $tag with $zip" -ForegroundColor Green
