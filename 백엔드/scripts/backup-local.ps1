param(
    [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\..\.build\backend\backups'),
    [string]$ApplicationProject = 'hufs-town',
    [string]$MediaProject = 'hufs-town-media'
)

$ErrorActionPreference = 'Stop'

function Get-ComposeContainer([string]$Project, [string]$Service) {
    $ids = @(& docker ps -q --filter "label=com.docker.compose.project=$Project" --filter "label=com.docker.compose.service=$Service")
    if ($LASTEXITCODE -ne 0) { throw "Docker에서 $Project/$Service 컨테이너를 조회하지 못했습니다." }
    if ($ids.Count -ne 1 -or [string]::IsNullOrWhiteSpace($ids[0])) {
        throw "$Project/$Service 실행 컨테이너가 하나여야 합니다. 조회된 수: $($ids.Count)"
    }
    return $ids[0].Trim()
}

function Assert-RunningContainer([string]$ContainerId, [string]$Label) {
    $stateText = (& docker inspect --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' $ContainerId 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw "$Label 컨테이너 상태를 확인하지 못했습니다: $stateText" }
    $state = $stateText.Split('|')
    if ($state[0] -ne 'running' -or ($state[1] -ne 'none' -and $state[1] -ne 'healthy')) {
        throw "$Label 컨테이너가 실행/정상 상태가 아닙니다. 상태: $stateText"
    }
}

function Invoke-DockerToFile([string[]]$Arguments, [string]$Path) {
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = 'docker'
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    foreach ($argument in $Arguments) { [void]$startInfo.ArgumentList.Add($argument) }

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    if (-not $process.Start()) { throw 'Docker 백업 프로세스를 시작하지 못했습니다.' }
    $errorTask = $process.StandardError.ReadToEndAsync()
    $file = [System.IO.File]::Create($Path)
    try { $process.StandardOutput.BaseStream.CopyTo($file) }
    finally { $file.Dispose() }
    $process.WaitForExit()
    $errorText = $errorTask.GetAwaiter().GetResult()
    if ($process.ExitCode -ne 0) {
        throw "Docker 백업 명령이 실패했습니다 (exit $($process.ExitCode)): $errorText"
    }
}

function Invoke-DockerChecked([string[]]$Arguments, [string]$Label) {
    $output = @(& docker @Arguments 2>&1)
    if ($LASTEXITCODE -ne 0) { throw "$Label 실패: $($output -join ' ')" }
}

function Copy-ContainerDirectory([string]$ContainerId, [string]$Source, [string]$Destination) {
    [void](New-Item -ItemType Directory -Force -Path $Destination)
    Invoke-DockerChecked @('cp', "$($ContainerId):$Source/.", $Destination) "컨테이너 경로 $Source 백업"
}

$outputRoot = [System.IO.Path]::GetFullPath($OutputDirectory)
[void](New-Item -ItemType Directory -Force -Path $outputRoot)
$stamp = [DateTimeOffset]::UtcNow.ToString('yyyyMMddTHHmmssZ')
$suffix = [Guid]::NewGuid().ToString('N').Substring(0, 8)
$partialPath = [System.IO.Path]::GetFullPath((Join-Path $outputRoot ".partial-$stamp-$suffix"))
$finalPath = [System.IO.Path]::GetFullPath((Join-Path $outputRoot "hufs-town-backup-$stamp-$suffix"))
$rootPrefix = $outputRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if (-not $partialPath.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase) -or
    -not $finalPath.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw '백업 경로가 출력 디렉터리 밖을 가리킵니다.'
}

$completed = $false
try {
    $database = Get-ComposeContainer $ApplicationProject 'mariadb'
    $api = Get-ComposeContainer $ApplicationProject 'api'
    $media = Get-ComposeContainer $MediaProject 'media'
    Assert-RunningContainer $database 'MariaDB'
    Assert-RunningContainer $api 'API'
    Assert-RunningContainer $media '미디어'

    [void](New-Item -ItemType Directory -Force -Path $partialPath)
    [void](New-Item -ItemType Directory -Force -Path (Join-Path $partialPath 'assets'))
    [void](New-Item -ItemType Directory -Force -Path (Join-Path $partialPath 'recordings'))

    $dumpCommand = 'MYSQL_PWD="$MARIADB_ROOT_PASSWORD" mariadb-dump --user=root --single-transaction --routines --events --triggers --hex-blob --default-character-set=utf8mb4 hufstown'
    Invoke-DockerToFile @('exec', $database, 'sh', '-c', $dumpCommand) (Join-Path $partialPath 'database.sql')
    if ((Get-Item -LiteralPath (Join-Path $partialPath 'database.sql')).Length -lt 1024) {
        throw 'MariaDB 덤프가 예상보다 작습니다. 불완전한 백업을 저장하지 않았습니다.'
    }

    Copy-ContainerDirectory $api '/data/assets' (Join-Path $partialPath 'assets')
    Copy-ContainerDirectory $media '/data/recordings' (Join-Path $partialPath 'recordings')

    $sourceFiles = @(Get-ChildItem -LiteralPath $partialPath -File -Recurse -Force)
    foreach ($sourceFile in $sourceFiles) {
        if (($sourceFile.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "심볼릭 링크/재분석 지점은 백업할 수 없습니다: $($sourceFile.FullName)"
        }
    }
    $files = @($sourceFiles | ForEach-Object {
        [pscustomobject]@{
            path = $_.FullName.Substring($partialPath.Length + 1).Replace('\', '/')
            sizeBytes = $_.Length
            sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    } | Sort-Object path)
    $manifest = [ordered]@{
        formatVersion = 1
        createdAt = [DateTimeOffset]::UtcNow.ToString('O')
        database = 'hufstown'
        contents = @('mariadb-logical-dump', 'space-assets', 'room-recordings')
        excluded = @('redis-runtime-state', 'environment-secrets', 'prometheus-time-series')
        recoveryNotes = @(
            'Redis에는 로그인 세션·좌석·lease 등 만료되는 런타임 상태가 있어 복원하지 않습니다.',
            '앱 비밀값은 백업에 포함되지 않습니다. 복구 환경의 비밀 관리자에서 별도로 주입해야 합니다.',
            'DB 덤프와 파일 볼륨은 순차 복사되므로 트래픽이 계속 변하는 동안의 프로덕션 원자 스냅샷을 보장하지 않습니다.'
        )
        files = $files
    }
    $manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $partialPath 'manifest.json') -Encoding utf8NoBOM

    [System.IO.Directory]::Move($partialPath, $finalPath)
    $completed = $true
    Write-Output $finalPath
}
finally {
    if (-not $completed -and (Test-Path -LiteralPath $partialPath) -and
        $partialPath.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $partialPath -Recurse -Force
    }
}
