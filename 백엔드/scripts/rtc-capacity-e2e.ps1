param(
    [ValidateSet(2, 12, 25, 50, 100)][int]$Clients = 2,
    [ValidateRange(1, 12)][int]$Speakers = 1,
    [ValidateRange(512, 65536)][int]$MinFreeMemoryMb = 2048,
    [ValidateRange(0, 600)][int]$RtpHoldSeconds = 0,
    [switch]$ModuleHarness,
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$backendRoot = Split-Path $PSScriptRoot -Parent
$workspaceRoot = Split-Path $backendRoot -Parent
$frontendRoot = Join-Path $workspaceRoot '프론트'
$isolatedSfuName = 'hufs-town-media-capacity-test'
$isolatedControlUrl = 'http://127.0.0.1:18083'
$runId = "$(Get-Date -Format 'yyyyMMdd-HHmmss')-$PID"
$runDirectory = Join-Path $workspaceRoot ".build/backend/rtc-capacity/$runId"
$resultPath = Join-Path $runDirectory 'rtc-capacity.json'
$apiLog = Join-Path $runDirectory 'api.log'
$worldLog = Join-Path $runDirectory 'world.log'
$webLog = Join-Path $runDirectory 'web.log'
$apiErrorLog = Join-Path $runDirectory 'api.error.log'
$worldErrorLog = Join-Path $runDirectory 'world.error.log'
$webErrorLog = Join-Path $runDirectory 'web.error.log'
$children = @()
$originalEnvironment = @{}
$environmentKeys = @(
    'TOWN_E2E_BASE_URL', 'TOWN_API_TARGET', 'TOWN_WORLD_TARGET', 'TOWN_E2E_MEDIA',
    'TOWN_RTC_CAPACITY', 'TOWN_RTC_CAPACITY_CLIENTS', 'TOWN_RTC_CAPACITY_SPEAKERS',
    'TOWN_RTC_CAPACITY_OUTPUT', 'TOWN_RTC_CAPACITY_MIN_FREE_MB',
    'TOWN_RTC_CAPACITY_RTP_HOLD_SECONDS', 'TOWN_VITE_HOST',
    'TOWN_MEDIA_ENABLED', 'MEDIA_CONTROL_URL', 'MEDIA_CONTROL_TOKEN'
)
foreach ($key in $environmentKeys) {
    $originalEnvironment[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
}

function Get-TestPort([string]$Address) {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Parse($Address), 0)
    $listener.Start()
    try { return $listener.LocalEndpoint.Port }
    finally { $listener.Stop() }
}

function Read-DotEnvValue([string]$FilePath, [string]$Name) {
    if (-not (Test-Path -LiteralPath $FilePath)) { return $null }
    foreach ($line in [System.IO.File]::ReadAllLines($FilePath)) {
        if ($line -match "^\s*$([Regex]::Escape($Name))\s*=\s*(.*)\s*$") {
            $value = $Matches[1].Trim()
            if ($value.Length -ge 2 -and (($value[0] -eq '"' -and $value[-1] -eq '"') -or ($value[0] -eq "'" -and $value[-1] -eq "'"))) {
                $value = $value.Substring(1, $value.Length - 2)
            }
            return $value
        }
    }
    return $null
}

function Wait-Ready([string]$Url, [System.Diagnostics.Process]$Process, [string]$Label) {
    for ($attempt = 0; $attempt -lt 120; $attempt++) {
        if ($Process.HasExited) { throw "$Label stopped during startup (exit $($Process.ExitCode)). See the run directory for its local log." }
        try {
            $response = Invoke-WebRequest -Uri $Url -TimeoutSec 2 -UseBasicParsing
            if ($response.StatusCode -eq 200) { return }
        } catch { }
        Start-Sleep -Milliseconds 500
    }
    throw "$Label did not become ready at $Url. See the run directory for its local log."
}

try {
    if ($Speakers -ge $Clients) { throw 'Speakers must be lower than the selected participant tier.' }
    New-Item -ItemType Directory -Path $runDirectory -Force | Out-Null

    # Require the exact disposable SFU and loopback-only published endpoints. Never inspect or print container environment values.
    $sfuFacts = (& docker ps --filter "name=^/$isolatedSfuName$" --format '{{.Names}}|{{.Ports}}' 2>$null | Select-Object -First 1)
    if (-not $sfuFacts -or $sfuFacts -notmatch '^hufs-town-media-capacity-test\|') {
        throw "The isolated SFU $isolatedSfuName is not running. No media test was started."
    }
    if ($sfuFacts -notmatch '127\.0\.0\.1:18083->18082/tcp' -or
        $sfuFacts -notmatch '127\.0\.0\.1:44445->44445/udp' -or
        $sfuFacts -notmatch '127\.0\.0\.1:44445->44445/tcp') {
        throw 'The isolated SFU does not match the required loopback-only control and RTC port mapping. No media test was started.'
    }
    $safeSfuSettings = @(& docker inspect --format '{{json .Config.Env}}' $isolatedSfuName | ConvertFrom-Json) |
        Where-Object { $_ -match '^(MEDIA_ANNOUNCED_ADDRESS|MEDIA_RTC_PORT)=' }
    if ($safeSfuSettings -notcontains 'MEDIA_ANNOUNCED_ADDRESS=127.0.0.1' -or
        $safeSfuSettings -notcontains 'MEDIA_RTC_PORT=44445') {
        throw 'The isolated SFU does not announce the verified loopback RTC address and port. No media test was started.'
    }
    $workspaceEngineHash = (Get-FileHash -Algorithm SHA256 (Join-Path $backendRoot 'apps/media/src/engine.mjs')).Hash.ToLowerInvariant()
    $isolatedEngineHash = (& docker exec $isolatedSfuName node -e "const c=require('node:crypto');const f=require('node:fs');process.stdout.write(c.createHash('sha256').update(f.readFileSync('/app/src/engine.mjs')).digest('hex'))").Trim()
    if (-not $isolatedEngineHash -or $isolatedEngineHash -ne $workspaceEngineHash) {
        throw 'The isolated SFU policy source differs from the workspace. Rebuild only hufs-town-media-capacity-test from apps/media before running this tier.'
    }
    $health = Invoke-RestMethod -Uri "$isolatedControlUrl/health" -TimeoutSec 3
    if ($health.status -ne 'UP') { throw 'The isolated SFU health check did not pass.' }

    if (-not $SkipBuild) {
        & (Join-Path $PSScriptRoot 'gradle.ps1') :apps:api:bootJar :apps:world:bootJar
        if ($LASTEXITCODE -ne 0) { throw 'Preview API/World build failed.' }
    }
    $apiJar = Join-Path $workspaceRoot '.build/backend/apps/api/libs/api-0.1.0-SNAPSHOT.jar'
    $worldJar = Join-Path $workspaceRoot '.build/backend/apps/world/libs/world-0.1.0-SNAPSHOT.jar'
    if (-not (Test-Path -LiteralPath $apiJar) -or -not (Test-Path -LiteralPath $worldJar)) {
        throw 'Preview API/World JARs are missing. Run without -SkipBuild.'
    }

    $mediaToken = [Environment]::GetEnvironmentVariable('MEDIA_CONTROL_TOKEN', 'Process')
    if (-not $mediaToken) { $mediaToken = Read-DotEnvValue (Join-Path $backendRoot '.env') 'MEDIA_CONTROL_TOKEN' }
    if (-not $mediaToken -or $mediaToken.Length -lt 32) {
        throw 'MEDIA_CONTROL_TOKEN is unavailable. Set it in the backend .env; its value will not be printed or written by this script.'
    }
    # A GET to a protected, unknown route is intentionally non-mutating: valid auth yields 404, invalid auth yields 401.
    $tokenPreflightStatus = 0
    try {
        $probe = Invoke-WebRequest -Uri "$isolatedControlUrl/v1/preflight" -Method Get -Headers @{ Authorization = "Bearer $mediaToken" } -TimeoutSec 3 -UseBasicParsing
        $tokenPreflightStatus = [int]$probe.StatusCode
    } catch {
        if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
            $tokenPreflightStatus = [int]$_.Exception.Response.StatusCode
        }
    }
    if ($tokenPreflightStatus -ne 404) {
        throw "The isolated SFU token preflight failed with HTTP $tokenPreflightStatus. Check the configured token; its value was not printed."
    }

    $taskJava = Get-ChildItem -LiteralPath "$env:USERPROFILE/.jdks" -Directory -ErrorAction SilentlyContinue |
        Where-Object Name -Match '21' | Select-Object -First 1 -ExpandProperty FullName
    if (-not $taskJava) { throw 'JDK 21 is required.' }
    $apiPort = Get-TestPort '127.0.0.1'
    $worldPort = Get-TestPort '127.0.0.1'
    $webPort = Get-TestPort '::1'
    $origin = "http://localhost:$webPort"
    $apiTarget = "http://127.0.0.1:$apiPort"
    $worldTarget = "http://127.0.0.1:$worldPort"

    # Keep pre-existing media credentials out of the disposable API and frontend process environments.
    $env:MEDIA_CONTROL_URL = $null
    $env:MEDIA_CONTROL_TOKEN = $null
    # API only exposes the media feature flag; it does not receive the SFU token or control URL.
    $env:TOWN_MEDIA_ENABLED = 'true'
    $apiArguments = @('-jar', $apiJar, '--spring.profiles.active=preview', '--town.auth.mode=preview', "--server.port=$apiPort", "--town.public-origin=$origin")
    $children += Start-Process -FilePath "$taskJava/bin/java.exe" -ArgumentList $apiArguments -WorkingDirectory $backendRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $apiLog -RedirectStandardError $apiErrorLog

    # Pass the secret only through this child process environment; it is not placed on a command line or in a saved configuration.
    $env:MEDIA_CONTROL_URL = $isolatedControlUrl
    $env:MEDIA_CONTROL_TOKEN = $mediaToken
    $env:TOWN_MEDIA_ENABLED = 'true'
    $worldArguments = @(
        '-jar', $worldJar,
        '--spring.profiles.active=preview', '--town.auth.mode=preview',
        '--town.auth.preview-identities-enabled=true', '--town.auth.preview-multimap-enabled=true',
        "--server.port=$worldPort", "--town.public-origin=$origin"
    )
    $children += Start-Process -FilePath "$taskJava/bin/java.exe" -ArgumentList $worldArguments -WorkingDirectory $backendRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $worldLog -RedirectStandardError $worldErrorLog
    [Environment]::SetEnvironmentVariable('MEDIA_CONTROL_TOKEN', $null, 'Process')
    [Environment]::SetEnvironmentVariable('MEDIA_CONTROL_URL', $null, 'Process')
    [Environment]::SetEnvironmentVariable('TOWN_MEDIA_ENABLED', 'false', 'Process')
    $mediaToken = $null

    Wait-Ready "$apiTarget/actuator/health" $children[0] 'Preview API'
    Wait-Ready "$worldTarget/actuator/health" $children[1] 'Isolated preview World'

    $nodePath = (Get-Command node -ErrorAction Stop).Source
    $viteScript = Join-Path $frontendRoot 'node_modules/vite/bin/vite.js'
    $webArguments = @($viteScript, '--host', '::1', '--port', $webPort, '--strictPort')
    $env:TOWN_API_TARGET = $apiTarget
    $env:TOWN_WORLD_TARGET = $worldTarget
    $env:TOWN_VITE_HOST = '::1'
    $children += Start-Process -FilePath $nodePath -ArgumentList $webArguments -WorkingDirectory $frontendRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $webLog -RedirectStandardError $webErrorLog
    Wait-Ready $origin $children[2] 'Isolated frontend'

    $env:TOWN_E2E_BASE_URL = $origin
    $env:TOWN_E2E_MEDIA = 'true'
    $env:TOWN_RTC_CAPACITY = 'true'
    $env:TOWN_RTC_CAPACITY_CLIENTS = "$Clients"
    $env:TOWN_RTC_CAPACITY_SPEAKERS = "$Speakers"
    $env:TOWN_RTC_CAPACITY_RTP_HOLD_SECONDS = "$RtpHoldSeconds"
    $env:TOWN_RTC_CAPACITY_OUTPUT = $resultPath
    $env:TOWN_RTC_CAPACITY_MIN_FREE_MB = "$MinFreeMemoryMb"

    Push-Location $frontendRoot
    try {
        $testSpec = if ($ModuleHarness) { 'tests/e2e/rtc-capacity-module-harness.spec.ts' } else { 'tests/e2e/rtc-capacity.spec.ts' }
        & pnpm exec playwright test $testSpec --project=chromium --workers=1 "--output=$runDirectory/playwright-results"
        $testExit = $LASTEXITCODE
    } finally { Pop-Location }
    if ($testExit -ne 0) { throw "RTC capacity tier $Clients did not pass. Review its raw result and local logs under $runDirectory." }
    if (-not (Test-Path -LiteralPath $resultPath)) { throw 'The browser test passed without writing its evidence JSON.' }

    Write-Output "RTC capacity tier $Clients passed against the isolated loopback SFU. Evidence: $resultPath"
} finally {
    foreach ($child in $children) {
        if ($child -and -not $child.HasExited) {
            Stop-Process -InputObject $child -Force -ErrorAction SilentlyContinue
        }
    }
    foreach ($key in $environmentKeys) {
        [Environment]::SetEnvironmentVariable($key, $originalEnvironment[$key], 'Process')
    }
}
