[CmdletBinding()]
param(
  [switch]$SkipTests
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$manifestPath = Join-Path $projectRoot "manifest.json"
$releaseDirectory = Join-Path $projectRoot "release"
$stagingDirectory = Join-Path ([System.IO.Path]::GetTempPath()) (
  "popup-as-tab-package-" + [System.Guid]::NewGuid().ToString("N")
)

$packageFiles = @(
  "manifest.json"
  "dist/background.js"
  "popup.html"
  "popup.css"
  "popup.js"
  "icons/icon16.png"
  "icons/icon32.png"
  "icons/icon48.png"
  "icons/icon128-sized.png"
)

Push-Location $projectRoot
try {
  if ($SkipTests) {
    & npm.cmd run build
  } else {
    & npm.cmd test
  }
  if ($LASTEXITCODE -ne 0) {
    throw "Build or tests failed with exit code $LASTEXITCODE."
  }

  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  if (-not $manifest.version) {
    throw "manifest.json does not contain a version."
  }

  $archiveName = "popup-as-tab-$($manifest.version).zip"
  $archivePath = Join-Path $releaseDirectory $archiveName

  New-Item -ItemType Directory -Path $stagingDirectory | Out-Null
  foreach ($relativePath in $packageFiles) {
    $sourcePath = Join-Path $projectRoot $relativePath
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
      throw "Required package file is missing: $relativePath"
    }

    $destinationPath = Join-Path $stagingDirectory $relativePath
    $destinationDirectory = Split-Path -Parent $destinationPath
    New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null
    Copy-Item -LiteralPath $sourcePath -Destination $destinationPath
  }

  New-Item -ItemType Directory -Path $releaseDirectory -Force | Out-Null
  Compress-Archive -Path (Join-Path $stagingDirectory "*") -DestinationPath $archivePath -Force

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
  try {
    $actualEntries = @($archive.Entries | ForEach-Object { $_.FullName.Replace("\", "/") })
  } finally {
    $archive.Dispose()
  }

  $expectedEntries = @($packageFiles | ForEach-Object { $_.Replace("\", "/") })
  $entryDifference = Compare-Object $expectedEntries $actualEntries
  if ($entryDifference) {
    throw "ZIP contents do not match the package allowlist: $entryDifference"
  }

  Write-Host "Created $archivePath"
} finally {
  Pop-Location
  if (Test-Path -LiteralPath $stagingDirectory) {
    Remove-Item -LiteralPath $stagingDirectory -Recurse -Force
  }
}
