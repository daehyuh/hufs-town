param([switch]$SkipBuild, [switch]$Media, [switch]$MultiMapPreview, [string[]]$TestFile = @(), [string]$TestName = '')
$ErrorActionPreference = 'Stop'
$taskBackend = Split-Path $PSScriptRoot -Parent
$taskRoot = Split-Path $taskBackend -Parent
$taskFrontend = Join-Path $taskRoot '프론트'
$taskLogs = Join-Path $taskRoot '.local/hufs-town/e2e'
New-Item -ItemType Directory -Path $taskLogs -Force | Out-Null
if (-not $SkipBuild) { & "$PSScriptRoot/gradle.ps1" :apps:api:bootJar :apps:world:bootJar; if ($LASTEXITCODE) { exit $LASTEXITCODE } }
$taskJava = Get-ChildItem -LiteralPath "$env:USERPROFILE/.jdks" -Directory | Where-Object Name -Match '21' | Select-Object -First 1 -ExpandProperty FullName
if (-not $taskJava) { throw 'JDK 21 is required.' }
function Get-TestPort([string]$Address) {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Parse($Address), 0)
    $listener.Start(); $port = $listener.LocalEndpoint.Port; $listener.Stop(); return $port
}
$taskApiPort = Get-TestPort '127.0.0.1'
$taskWorldPort = Get-TestPort '127.0.0.1'
$taskWebPort = Get-TestPort '::1'
$taskOrigin = "http://localhost:$taskWebPort"
$taskChildren = @()
$taskHasSpaceParticipantE2E = @($TestFile | ForEach-Object { $_ -replace '\\', '/' }) -contains 'tests/e2e/space-participants.spec.ts'
$taskEnableMultiMapPreview = $MultiMapPreview -or ($TestFile.Count -eq 0) -or $taskHasSpaceParticipantE2E
$taskSettings = @('TOWN_E2E_BASE_URL','TOWN_API_TARGET','TOWN_WORLD_TARGET','TOWN_E2E_MEDIA','TOWN_E2E_MEDIA_CONTAINER','TOWN_MEDIA_ENABLED','TOWN_E2E_TURN','MEDIA_CONTROL_URL','MEDIA_CONTROL_TOKEN','MEDIA_ICE_SERVERS_JSON','MEDIA_ANNOUNCED_ADDRESS','MEDIA_RTC_PORT')
$taskPrevious = @{}
foreach ($key in $taskSettings) { $taskPrevious[$key] = [Environment]::GetEnvironmentVariable($key, 'Process') }
try {
    $env:TOWN_MEDIA_ENABLED = if ($Media) { 'true' } else { 'false' }
    $env:TOWN_E2E_MEDIA = if ($Media) { 'true' } else { 'false' }
    if ($Media) {
        if (-not $env:MEDIA_CONTROL_URL -or -not $env:MEDIA_CONTROL_TOKEN) {
            foreach ($taskLine in Get-Content -LiteralPath "$taskBackend/.env" -Encoding utf8) {
                if (-not $env:MEDIA_CONTROL_URL -and $taskLine -match '^MEDIA_CONTROL_URL=(.*)$') {
                    [Environment]::SetEnvironmentVariable('MEDIA_CONTROL_URL', $Matches[1].Trim().Trim('"').Trim("'"), 'Process')
                }
                if (-not $env:MEDIA_CONTROL_TOKEN -and $taskLine -match '^MEDIA_CONTROL_TOKEN=(.*)$') {
                    [Environment]::SetEnvironmentVariable('MEDIA_CONTROL_TOKEN', $Matches[1].Trim().Trim('"').Trim("'"), 'Process')
                }
            }
        }
        if (-not $env:MEDIA_CONTROL_TOKEN) { throw 'Run scripts/media.ps1 start before media tests.' }
        Invoke-RestMethod "$env:MEDIA_CONTROL_URL/health" -TimeoutSec 3 | Out-Null
        $taskMediaContainer = & docker compose --env-file "$taskBackend/.env" -f "$taskBackend/infra/media.compose.yaml" ps -q media
        if ($LASTEXITCODE -ne 0 -or -not $taskMediaContainer) { throw 'The media recording container is unavailable.' }
        $env:TOWN_E2E_MEDIA_CONTAINER = ($taskMediaContainer | Select-Object -First 1).Trim()
    }
    foreach ($app in @(@{ Name='api'; Port=$taskApiPort }, @{ Name='world'; Port=$taskWorldPort })) {
        $jar = Join-Path $taskRoot ".build/backend/apps/$($app.Name)/libs/$($app.Name)-0.1.0-SNAPSHOT.jar"
        $taskArguments = @('-jar', $jar, '--spring.profiles.active=preview', '--town.auth.mode=preview', "--server.port=$($app.Port)", "--town.public-origin=$taskOrigin")
        if ($app.Name -eq 'world' -and $Media) { $taskArguments += '--town.auth.preview-identities-enabled=true' }
        if ($app.Name -eq 'world' -and $taskEnableMultiMapPreview) { $taskArguments += '--town.auth.preview-multimap-enabled=true' }
        $taskChildren += Start-Process -FilePath "$taskJava/bin/java.exe" -ArgumentList $taskArguments -WindowStyle Hidden -PassThru -RedirectStandardOutput "$taskLogs/$($app.Name).log" -RedirectStandardError "$taskLogs/$($app.Name).error.log"
    }
    $env:TOWN_E2E_BASE_URL = $taskOrigin
    $env:TOWN_API_TARGET = "http://127.0.0.1:$taskApiPort"
    $env:TOWN_WORLD_TARGET = "http://127.0.0.1:$taskWorldPort"
    $taskNode = (Get-Command node).Source
    $taskVite = Join-Path $taskFrontend 'node_modules/vite/bin/vite.js'
    $taskChildren += Start-Process -FilePath $taskNode -ArgumentList @($taskVite, '--host', '::1', '--port', $taskWebPort) -WorkingDirectory $taskFrontend -WindowStyle Hidden -PassThru -RedirectStandardOutput "$taskLogs/web.log" -RedirectStandardError "$taskLogs/web.error.log"
    foreach ($url in @("$env:TOWN_API_TARGET/actuator/health", "$env:TOWN_WORLD_TARGET/actuator/health", $taskOrigin)) {
        $ready = $false
        for ($attempt = 0; $attempt -lt 60; $attempt++) {
            try { if ((Invoke-WebRequest -Uri $url -TimeoutSec 1).StatusCode -eq 200) { $ready = $true; break } } catch { }
            Start-Sleep -Milliseconds 250
        }
        if (-not $ready) { throw "Test server unavailable at $url. See $taskLogs" }
    }
    Push-Location $taskFrontend
    try {
        $taskTestArgs = @('test:e2e')
        if ($TestName) { $taskTestArgs += @('--grep', $TestName) }
        $taskTestArgs += $TestFile
        & pnpm @taskTestArgs
        $taskExit = $LASTEXITCODE
    } finally { Pop-Location }
} finally {
    foreach ($child in $taskChildren) { if (-not $child.HasExited) { Stop-Process -InputObject $child } }
    foreach ($key in $taskSettings) { [Environment]::SetEnvironmentVariable($key, $taskPrevious[$key], 'Process') }
}
exit $taskExit
