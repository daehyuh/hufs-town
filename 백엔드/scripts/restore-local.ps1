param(
    [Parameter(Mandatory = $true)][string]$BackupDirectory,
    [string]$DatabaseTarget = 'hufstown_restore',
    [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\..\.build\backend\restores'),
    [string]$ApplicationProject = 'hufs-town',
    [switch]$ReplaceDatabase
)

$ErrorActionPreference = 'Stop'
if ($DatabaseTarget -notmatch '^[A-Za-z][A-Za-z0-9_]{0,63}$') {
    throw '복원 DB 이름은 영문자로 시작하는 1–64자의 영문·숫자·밑줄만 사용할 수 있습니다.'
}

$backupRoot = [System.IO.Path]::GetFullPath($BackupDirectory)
& (Join-Path $PSScriptRoot 'verify-local-backup.ps1') -BackupDirectory $backupRoot

$databaseIds = @(& docker ps -q --filter "label=com.docker.compose.project=$ApplicationProject" --filter 'label=com.docker.compose.service=mariadb')
if ($LASTEXITCODE -ne 0 -or $databaseIds.Count -ne 1 -or [string]::IsNullOrWhiteSpace($databaseIds[0])) {
    throw "$ApplicationProject/mariadb 실행 컨테이너가 하나여야 합니다."
}
$databaseId = $databaseIds[0].Trim()

$query = "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='$DatabaseTarget'"
$queryCommand = 'MYSQL_PWD="$MARIADB_ROOT_PASSWORD" mariadb --user=root --batch --skip-column-names --execute="$1"'
$existing = @(& docker exec $databaseId sh -c $queryCommand sh $query 2>&1)
if ($LASTEXITCODE -ne 0) { throw "복원 대상 DB를 확인하지 못했습니다: $($existing -join ' ')" }
$databaseExists = @($existing | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }).Count -gt 0
if ($databaseExists -and -not $ReplaceDatabase) {
    throw "DB '$DatabaseTarget'이 이미 있습니다. 새 DB 이름을 지정하거나 교체 의도를 명시하세요."
}
if ($DatabaseTarget -eq 'hufstown' -and -not $ReplaceDatabase) {
    throw "주 DB hufstown을 대상으로 복원하려면 -ReplaceDatabase를 명시해야 합니다."
}

$outputRoot = [System.IO.Path]::GetFullPath($OutputDirectory)
[void](New-Item -ItemType Directory -Force -Path $outputRoot)
$restoreName = 'hufs-town-restore-' + [DateTimeOffset]::UtcNow.ToString('yyyyMMddTHHmmssZ') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$restorePath = [System.IO.Path]::GetFullPath((Join-Path $outputRoot $restoreName))
$prefix = $outputRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if (-not $restorePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw '복원 파일 경로가 출력 디렉터리 밖을 가리킵니다.'
}

[void](New-Item -ItemType Directory -Force -Path (Join-Path $restorePath 'assets'))
[void](New-Item -ItemType Directory -Force -Path (Join-Path $restorePath 'recordings'))
foreach ($name in @('assets', 'recordings')) {
    Get-ChildItem -LiteralPath (Join-Path $backupRoot $name) -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $restorePath $name) -Recurse -Force
    }
}

$dropSql = if ($databaseExists -and $ReplaceDatabase) { "DROP DATABASE ``$DatabaseTarget``;`n" } else { '' }
$setupSql = $dropSql + "CREATE DATABASE IF NOT EXISTS ``$DatabaseTarget`` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`nUSE ``$DatabaseTarget``;`n"
$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = 'docker'
$startInfo.UseShellExecute = $false
$startInfo.RedirectStandardInput = $true
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
foreach ($argument in @('exec', '-i', $databaseId, 'sh', '-c', 'MYSQL_PWD="$MARIADB_ROOT_PASSWORD" mariadb --user=root')) {
    [void]$startInfo.ArgumentList.Add($argument)
}
$process = [System.Diagnostics.Process]::new()
$process.StartInfo = $startInfo
if (-not $process.Start()) { throw 'MariaDB 복원 프로세스를 시작하지 못했습니다.' }
$stdoutTask = $process.StandardOutput.ReadToEndAsync()
$stderrTask = $process.StandardError.ReadToEndAsync()
try {
    $prefixBytes = [System.Text.UTF8Encoding]::new($false).GetBytes($setupSql)
    $process.StandardInput.BaseStream.Write($prefixBytes, 0, $prefixBytes.Length)
    $dump = [System.IO.File]::OpenRead((Join-Path $backupRoot 'database.sql'))
    try { $dump.CopyTo($process.StandardInput.BaseStream) }
    finally { $dump.Dispose() }
}
finally {
    $process.StandardInput.Close()
}
$process.WaitForExit()
$stdout = $stdoutTask.GetAwaiter().GetResult()
$stderr = $stderrTask.GetAwaiter().GetResult()
if ($process.ExitCode -ne 0) { throw "MariaDB 복원에 실패했습니다 (exit $($process.ExitCode)): $stderr $stdout" }

$verifySql = "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='$DatabaseTarget'"
$verifyCommand = 'MYSQL_PWD="$MARIADB_ROOT_PASSWORD" mariadb --user=root --batch --skip-column-names --execute="$1"'
$tableCount = @(& docker exec $databaseId sh -c $verifyCommand sh $verifySql 2>&1)
if ($LASTEXITCODE -ne 0 -or [int]($tableCount | Select-Object -First 1) -lt 1) {
    throw "복원 DB '$DatabaseTarget'의 테이블 검증에 실패했습니다."
}

[pscustomobject]@{
    database = $DatabaseTarget
    tableCount = [int]($tableCount | Select-Object -First 1)
    filesDirectory = $restorePath
    note = '파일은 별도 디렉터리에 복원했습니다. 검증 후 애플리케이션 볼륨에 적용하세요.'
}
