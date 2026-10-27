$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$workspace = $PSScriptRoot
$manifest = Get-Content -LiteralPath (Join-Path $workspace 'manifest.json') -Raw | ConvertFrom-Json
$version = $manifest.version
$outputDirectory = Join-Path $workspace 'dist'
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$files = @('README.md', 'SOURCES.md', 'background.js', 'popup.html', 'popup.js', 'download.html', 'download.js', 'hls.js', 'mp4.js', 'fallback.js', 'resource-mode.js', 'mux.min.js', 'mux.LICENSE.txt', 'icons/icon16.png', 'icons/icon32.png', 'icons/icon48.png', 'icons/icon128.png')
foreach ($flavor in @('chrome', 'firefox')) {
  $release = Get-Content -LiteralPath (Join-Path $workspace 'manifest.json') -Raw | ConvertFrom-Json
  $suffix = ''
  if ($flavor -eq 'chrome') {
    $release.background.PSObject.Properties.Remove('scripts')
    $release.PSObject.Properties.Remove('browser_specific_settings')
  } else {
    $release.background.PSObject.Properties.Remove('service_worker')
    $suffix = '-firefox'
  }
  $zipPath = Join-Path $outputDirectory "video-grabber-v$version$suffix.zip"
  $stream = [System.IO.File]::Open($zipPath, [System.IO.FileMode]::Create)
  $archive = [System.IO.Compression.ZipArchive]::new($stream, [System.IO.Compression.ZipArchiveMode]::Create)
  try {
    foreach ($file in $files) {
      [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, (Join-Path $workspace $file), $file, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
    $writer = [System.IO.StreamWriter]::new($archive.CreateEntry('manifest.json').Open(), [System.Text.UTF8Encoding]::new($false))
    try { $writer.Write(($release | ConvertTo-Json -Depth 10)) } finally { $writer.Dispose() }
  } finally { $archive.Dispose(); $stream.Dispose() }
  $check = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
  try {
    if ($check.Entries.Count -ne $files.Count + 1) { throw 'Unexpected release contents' }
    foreach ($file in $files) {
      $entryStream = $check.GetEntry($file).Open()
      $hasher = [System.Security.Cryptography.SHA256]::Create()
      try { $archivedHash = [BitConverter]::ToString($hasher.ComputeHash($entryStream)).Replace('-', '') }
      finally { $entryStream.Dispose(); $hasher.Dispose() }
      if ($archivedHash -ne (Get-FileHash -LiteralPath (Join-Path $workspace $file) -Algorithm SHA256).Hash) { throw "Archive mismatch: $file" }
    }
  } finally { $check.Dispose() }
  Write-Output "Verified: $zipPath"
}
