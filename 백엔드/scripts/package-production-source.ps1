param(
  [string]$ProjectRoot = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)),
  [string]$OutputDirectory = ''
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$BackendRoot = Join-Path $ProjectRoot '백엔드'
$FrontendRoot = Join-Path $ProjectRoot '프론트'
$RootDockerIgnore = Join-Path $ProjectRoot '.dockerignore'

foreach ($requiredPath in @($BackendRoot, $FrontendRoot, $RootDockerIgnore)) {
  if (-not (Test-Path -LiteralPath $requiredPath)) {
    throw "운영 소스 패키지에 필요한 경로가 없습니다: $requiredPath"
  }
}

if (-not $OutputDirectory) {
  $OutputDirectory = Join-Path $ProjectRoot '.build/deployment-source'
}
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
foreach ($sourceRoot in @($BackendRoot, $FrontendRoot)) {
  $sourcePrefix = [IO.Path]::GetFullPath($sourceRoot).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
  if ($OutputDirectory.StartsWith($sourcePrefix, [StringComparison]::OrdinalIgnoreCase) -or
      $OutputDirectory.Equals($sourceRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw '패키지 출력 경로는 백엔드·프론트 소스 디렉터리 안에 둘 수 없습니다.'
  }
}

if (Test-Path -LiteralPath $OutputDirectory) {
  $outputItem = Get-Item -LiteralPath $OutputDirectory -Force
  if (-not $outputItem.PSIsContainer -or
      ($outputItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw '패키지 출력 경로는 심볼릭 링크가 아닌 일반 디렉터리여야 합니다.'
  }
} else {
  New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
}
$OutputDirectory = (Resolve-Path -LiteralPath $OutputDirectory).Path

$tarCommand = Get-Command tar.exe -ErrorAction SilentlyContinue
if (-not $tarCommand) { throw 'Windows tar.exe를 찾을 수 없습니다.' }

$excludedDirectories = @(
  '.build', '.cache', '.gradle', '.local', '.pytest_cache', '__pycache__',
  'build', 'coverage', 'dist', 'node_modules', 'playwright-report', 'target',
  'test-results'
)
$excludedDirectoryPrefixes = @('.gradle')
$excludedFileExtensions = @('.log', '.tsbuildinfo', '.tmp', '.bak')

function Copy-SourceTree([string]$Source, [string]$Destination) {
  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  foreach ($entry in Get-ChildItem -LiteralPath $Source -Force) {
    if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      throw "링크/재분석 지점은 소스 패키지에 포함하지 않습니다: $($entry.FullName)"
    }
    if ($entry.Name.StartsWith('.env', [StringComparison]::OrdinalIgnoreCase)) {
      continue
    }
    if ($entry.PSIsContainer) {
      if ($excludedDirectories -contains $entry.Name -or
          @($excludedDirectoryPrefixes | Where-Object { $entry.Name.StartsWith($_, [StringComparison]::OrdinalIgnoreCase) }).Count -gt 0) {
        continue
      }
      Copy-SourceTree $entry.FullName (Join-Path $Destination $entry.Name)
      continue
    }

    if ($excludedFileExtensions -contains $entry.Extension.ToLowerInvariant()) {
      continue
    }
    Copy-Item -LiteralPath $entry.FullName -Destination (Join-Path $Destination $entry.Name)
  }
}

function Normalize-ArchivePath([string]$Entry) {
  $normalized = $Entry.Replace('\', '/')
  while ($normalized.StartsWith('./', [StringComparison]::Ordinal)) {
    $normalized = $normalized.Substring(2)
  }
  return $normalized.TrimEnd('/')
}

function Get-TarArchiveEntries([string]$ArchivePath) {
  Add-Type -AssemblyName System.Formats.Tar
  $file = [IO.File]::OpenRead($ArchivePath)
  $gzip = [IO.Compression.GZipStream]::new($file, [IO.Compression.CompressionMode]::Decompress)
  $reader = [System.Formats.Tar.TarReader]::new($gzip, $false)
  $entries = [Collections.Generic.List[object]]::new()
  try {
    while ($entry = $reader.GetNextEntry($false)) {
      $entries.Add([PSCustomObject]@{
        Name = $entry.Name
        EntryType = $entry.EntryType.ToString()
      })
    }
  } finally {
    $reader.Dispose()
    $gzip.Dispose()
    $file.Dispose()
  }
  return $entries.ToArray()
}

$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
$stageDirectory = Join-Path $tempRoot ("hufstown-package-{0}" -f [Guid]::NewGuid().ToString('N'))
$stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')
$suffix = [Guid]::NewGuid().ToString('N').Substring(0, 8)
$archiveName = "hufs-town-source-$stamp-$suffix.tar.gz"
$partialArchive = Join-Path $OutputDirectory ".partial-$archiveName"
$finalArchive = Join-Path $OutputDirectory $archiveName

try {
  New-Item -ItemType Directory -Path $stageDirectory | Out-Null
  Copy-SourceTree $BackendRoot (Join-Path $stageDirectory '백엔드')
  Copy-SourceTree $FrontendRoot (Join-Path $stageDirectory '프론트')
  Copy-Item -LiteralPath $RootDockerIgnore -Destination (Join-Path $stageDirectory '.dockerignore')

  $manifestPath = Join-Path $stageDirectory 'deployment-manifest.txt'
  $manifestEntries = @(
    Get-ChildItem -LiteralPath $stageDirectory -File -Recurse -Force | ForEach-Object {
      $relative = [IO.Path]::GetRelativePath($stageDirectory, $_.FullName).Replace('\', '/')
      if ($relative.Contains("`n") -or $relative.Contains("`r")) {
        throw "파일 이름에 줄바꿈이 있어 배포 manifest를 만들 수 없습니다: $relative"
      }
      $relative
    }
  )
  [Array]::Sort($manifestEntries, [StringComparer]::Ordinal)
  [IO.File]::WriteAllText(
    $manifestPath,
    ($manifestEntries -join "`n") + "`n",
    [Text.UTF8Encoding]::new($false)
  )

  & $tarCommand.Source -czf $partialArchive -C $stageDirectory .
  if ($LASTEXITCODE -ne 0) { throw "소스 압축에 실패했습니다 (tar exit $LASTEXITCODE)." }

  $archiveEntries = @(Get-TarArchiveEntries $partialArchive)
  $normalizedEntries = @($archiveEntries | ForEach-Object { Normalize-ArchivePath $_.Name })
  $archiveFiles = @(
    $archiveEntries | Where-Object { $_.EntryType -eq 'RegularFile' } |
      ForEach-Object { Normalize-ArchivePath $_.Name }
  )
  $requiredEntries = @('.dockerignore', '백엔드/infra/production.compose.yaml', '프론트/package.json')
  $missingEntries = @($requiredEntries | Where-Object { $normalizedEntries -notcontains $_ })
  if ($missingEntries.Count -gt 0) {
    $entrySample = @($normalizedEntries | Select-Object -First 10) -join ', '
    throw "압축 파일에서 배포 필수 파일을 확인하지 못했습니다: $($missingEntries -join ', ') (entries: $entrySample)"
  }

  if ($archiveFiles -notcontains 'deployment-manifest.txt') {
    throw '압축 파일에 deployment-manifest.txt가 없습니다.'
  }
  $actualManagedFiles = @($archiveFiles | Where-Object { $_ -ne 'deployment-manifest.txt' })
  $expectedFileSet = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  foreach ($entry in $manifestEntries) { [void]$expectedFileSet.Add($entry) }
  $actualFileSet = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  foreach ($entry in $actualManagedFiles) {
    if (-not $actualFileSet.Add($entry)) { throw "압축 파일에 중복 파일이 있습니다: $entry" }
  }
  $manifestMismatch = $actualManagedFiles.Count -ne $manifestEntries.Count -or
      $actualFileSet.Count -ne $expectedFileSet.Count
  if (-not $manifestMismatch) {
    foreach ($entry in $expectedFileSet) {
      if (-not $actualFileSet.Contains($entry)) { $manifestMismatch = $true; break }
    }
  }
  if ($manifestMismatch) {
    throw '압축 파일의 실제 파일 목록과 deployment manifest가 일치하지 않습니다.'
  }

  $forbiddenEntry = $archiveEntries | Where-Object {
    $normalized = Normalize-ArchivePath $_.Name
    $normalized -match '(^|/)\.env[^/]*(/|$)' -or
    $normalized -match '(^|/)(\.build|\.cache|\.gradle[^/]*|\.local|build|dist|node_modules|playwright-report|target|test-results|coverage|__pycache__)(/|$)' -or
    $normalized -match '\.(log|tsbuildinfo|tmp|bak)$'
  } | Select-Object -First 1
  if ($forbiddenEntry) { throw "제외 대상이 소스 압축에 들어갔습니다: $($forbiddenEntry.Name)" }

  if (Test-Path -LiteralPath $finalArchive) { throw '같은 이름의 운영 소스 압축 파일이 이미 있습니다.' }
  Move-Item -LiteralPath $partialArchive -Destination $finalArchive
  Write-Output $finalArchive
} finally {
  $stageFullPath = [IO.Path]::GetFullPath($stageDirectory)
  $stagePrefix = [IO.Path]::GetFileName($stageFullPath)
  $stageItem = Get-Item -LiteralPath $stageFullPath -Force -ErrorAction SilentlyContinue
  if ($stageFullPath.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and
      $stagePrefix.StartsWith('hufstown-package-', [StringComparison]::OrdinalIgnoreCase) -and
      $stageItem -and $stageItem.PSIsContainer -and
      -not ($stageItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    Remove-Item -LiteralPath $stageFullPath -Recurse -Force
  }
  if ((Test-Path -LiteralPath $partialArchive) -and
      [IO.Path]::GetFullPath((Split-Path -Parent $partialArchive)).Equals($OutputDirectory, [StringComparison]::OrdinalIgnoreCase) -and
      (Split-Path -Leaf $partialArchive).StartsWith('.partial-hufs-town-source-', [StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $partialArchive -Force
  }
}
