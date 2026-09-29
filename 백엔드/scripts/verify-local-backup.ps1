param([Parameter(Mandatory = $true)][string]$BackupDirectory)

$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath($BackupDirectory)
$rootItem = Get-Item -LiteralPath $root -Force
if (($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw '백업 경로는 심볼릭 링크/재분석 지점일 수 없습니다.'
}
$manifestPath = Join-Path $root 'manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw 'manifest.json 파일이 없습니다.'
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.formatVersion -ne 1 -or $manifest.database -ne 'hufstown' -or $null -eq $manifest.files) {
    throw '지원하지 않거나 올바르지 않은 백업 manifest입니다.'
}

$seen = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($entry in $manifest.files) {
    $relative = [string]$entry.path
    if ([string]::IsNullOrWhiteSpace($relative) -or [System.IO.Path]::IsPathRooted($relative) -or
        $relative.Split('/') -contains '..' -or -not $seen.Add($relative)) {
        throw "manifest 경로가 유효하지 않습니다: $relative"
    }
    $path = [System.IO.Path]::GetFullPath((Join-Path $root $relative.Replace('/', [System.IO.Path]::DirectorySeparatorChar)))
    $prefix = $root.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or
        -not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "백업 파일이 없거나 허용 경로 밖에 있습니다: $relative"
    }
    $item = Get-Item -LiteralPath $path
    if ($item.Length -ne [long]$entry.sizeBytes) { throw "파일 크기가 다릅니다: $relative" }
    $hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -ne ([string]$entry.sha256).ToLowerInvariant()) { throw "SHA-256 검증에 실패했습니다: $relative" }
}

if (-not $seen.Contains('database.sql')) { throw 'MariaDB 덤프가 manifest에 없습니다.' }
foreach ($directory in @('assets', 'recordings')) {
    $directoryPath = Join-Path $root $directory
    if (-not (Test-Path -LiteralPath $directoryPath -PathType Container)) {
        throw "백업의 $directory 디렉터리가 없습니다."
    }
    $directoryItem = Get-Item -LiteralPath $directoryPath -Force
    if (($directoryItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "백업의 $directory 디렉터리는 심볼릭 링크/재분석 지점일 수 없습니다."
    }
    foreach ($child in Get-ChildItem -LiteralPath $directoryPath -Recurse -Force) {
        if (($child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "백업에 심볼릭 링크/재분석 지점이 있습니다: $($child.FullName)"
        }
        if (-not $child.PSIsContainer) {
            $relative = $child.FullName.Substring($root.Length + 1).Replace('\', '/')
            if (-not $seen.Contains($relative)) { throw "manifest에 없는 파일이 있습니다: $relative" }
        }
    }
}

Write-Output "백업 무결성 확인 완료: $($manifest.files.Count)개 파일, 생성 $($manifest.createdAt)"
