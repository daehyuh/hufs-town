$ErrorActionPreference = 'Stop'
$taskBackend = Split-Path $PSScriptRoot -Parent
$taskCompose = Join-Path $taskBackend 'infra/media.turn-e2e.compose.yaml'
$taskProject = 'hufs-town-turn-e2e'
$taskNames = @('TURN_ANNOUNCED_IP','TURN_TEST_SHARED_SECRET','MEDIA_TURN_SHARED_SECRET','MEDIA_TURN_CREDENTIAL_TTL_SECONDS','MEDIA_CONTROL_TOKEN','MEDIA_CONTROL_URL','MEDIA_ICE_SERVERS_JSON','MEDIA_RTC_PORT','TOWN_E2E_TURN','TOWN_E2E_TURN_COMPOSE_FILE','TOWN_E2E_TURN_PROJECT')
$taskPrevious = @{}
foreach ($key in $taskNames) { $taskPrevious[$key] = [Environment]::GetEnvironmentVariable($key, 'Process') }
$taskStarted = $false
$taskExit = 1
try {
    $taskHostAddress = Get-NetIPConfiguration |
        Where-Object { $_.NetAdapter.Status -eq 'Up' -and $_.IPv4DefaultGateway } |
        ForEach-Object { $_.IPv4Address } |
        Where-Object { $_.AddressState -eq 'Preferred' -and $_.IPAddress -notmatch '^(127\.|169\.254\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.)' } |
        Select-Object -First 1 -ExpandProperty IPAddress
    if (-not $taskHostAddress) { throw 'TURN relay E2E needs an active non-loopback IPv4 address on the default route.' }

    $taskSharedSecret = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
    $taskControlToken = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
    $taskIceServers = ConvertTo-Json -Compress -InputObject @(@{
        urls = "turn:${taskHostAddress}:3478?transport=udp"
    })

    $env:TURN_ANNOUNCED_IP = $taskHostAddress
    $env:TURN_TEST_SHARED_SECRET = $taskSharedSecret
    $env:MEDIA_TURN_SHARED_SECRET = $taskSharedSecret
    $env:MEDIA_TURN_CREDENTIAL_TTL_SECONDS = '3600'
    $env:MEDIA_CONTROL_TOKEN = $taskControlToken
    $env:MEDIA_CONTROL_URL = 'http://127.0.0.1:18182'
    $env:MEDIA_ICE_SERVERS_JSON = $taskIceServers
    $env:MEDIA_RTC_PORT = '44446'
    $env:TOWN_E2E_TURN = 'true'
    $env:TOWN_E2E_TURN_COMPOSE_FILE = $taskCompose
    $env:TOWN_E2E_TURN_PROJECT = $taskProject

    $taskStarted = $true
    & docker compose -p $taskProject -f $taskCompose up -d --build --wait --wait-timeout 120
    if ($LASTEXITCODE -ne 0) { throw 'TURN E2E containers did not become ready.' }

    $taskReady = $false
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        $taskUdp = [System.Net.Sockets.UdpClient]::new()
        try {
            $taskUdp.Client.ReceiveTimeout = 300
            $taskTransaction = [Security.Cryptography.RandomNumberGenerator]::GetBytes(12)
            $taskRequest = [byte[]]@(0,1,0,0,0x21,0x12,0xa4,0x42) + $taskTransaction
            $taskEndpoint = [System.Net.IPEndPoint]::new([System.Net.IPAddress]::Parse($taskHostAddress), 3478)
            [void]$taskUdp.Send($taskRequest, $taskRequest.Length, $taskEndpoint)
            $taskResponse = $taskUdp.Receive([ref]$taskEndpoint)
            if ($taskResponse.Length -ge 20 -and $taskResponse[0] -eq 1 -and $taskResponse[1] -eq 1) {
                $taskReady = $true
                break
            }
        } catch { }
        finally { $taskUdp.Dispose() }
        Start-Sleep -Milliseconds 250
    }
    if (-not $taskReady) { throw 'Coturn did not answer a STUN binding check on the advertised host address.' }

    & "$PSScriptRoot/e2e.ps1" -SkipBuild -Media -TestFile tests/e2e/media.spec.ts -TestName 'real SFU carries'
    $taskExit = $LASTEXITCODE
} catch {
    [Console]::Error.WriteLine("TURN relay E2E failed: $($_.Exception.Message)")
} finally {
    if ($taskStarted -and $taskExit -ne 0) {
        $taskLogDirectory = Join-Path (Split-Path $taskBackend -Parent) '.local/hufs-town/e2e'
        New-Item -ItemType Directory -Path $taskLogDirectory -Force | Out-Null
        $taskCombinedLogs = foreach ($service in @('turn','media')) {
            & docker compose -p $taskProject -f $taskCompose logs --no-color $service 2>&1
        }
        $taskSafeLogs = foreach ($line in $taskCombinedLogs) {
            $safeLine = [string]$line
            if ($taskSharedSecret) { $safeLine = $safeLine.Replace($taskSharedSecret, '[redacted]') }
            if ($taskControlToken) { $safeLine = $safeLine.Replace($taskControlToken, '[redacted]') }
            $safeLine
        }
        [IO.File]::WriteAllLines((Join-Path $taskLogDirectory 'turn-services.log'), [string[]]$taskSafeLogs, [Text.UTF8Encoding]::new($false))
        [Console]::Error.WriteLine('TURN diagnostic log saved to .local/hufs-town/e2e/turn-services.log')
    }
    if ($taskStarted) {
        & docker compose -p $taskProject -f $taskCompose down --remove-orphans --volumes | Out-Null
        if ($LASTEXITCODE -ne 0 -and $taskExit -eq 0) { $taskExit = $LASTEXITCODE }
    }
    foreach ($key in $taskNames) { [Environment]::SetEnvironmentVariable($key, $taskPrevious[$key], 'Process') }
}
exit $taskExit
