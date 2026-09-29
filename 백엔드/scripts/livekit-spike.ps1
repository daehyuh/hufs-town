$ErrorActionPreference = 'Stop'
$taskBackend = Split-Path $PSScriptRoot -Parent
$taskRoot = Split-Path $taskBackend -Parent
$taskFrontend = Join-Path $taskRoot '프론트'
$containerName = 'hufstown-livekit-spike'
$image = 'livekit/livekit-server:v1.13.7'
$spikeApiKey = 'devkey'
$spikeSecret = 'TownLiveKitSpikeOnlySecret-DoNotUseInProduction-20260924'
$configPath = Join-Path $env:TEMP 'hufstown-livekit-spike.yaml'
$port = 17880
$webPort = 5199
$settingNames = @('TOWN_E2E_BASE_URL','TOWN_E2E_MEDIA','TOWN_E2E_LIVEKIT','TOWN_LIVEKIT_SPIKE_URL','TOWN_LIVEKIT_SPIKE_KEY','TOWN_LIVEKIT_SPIKE_SECRET')
$previousSettings = @{}
foreach ($name in $settingNames) { $previousSettings[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
$started = $false
$testExit = 1

try {
    $existing = @(docker ps -a --format '{{.Names}}' --filter "name=^${containerName}$" 2>$null)
    if ($existing -contains $containerName) { throw "Container '$containerName' already exists; inspect it before running the spike again." }

    $config = @"
port: 7880
rtc:
  udp_port: 7882
  node_ip: 127.0.0.1
  use_external_ip: false
keys:
  ${spikeApiKey}: ${spikeSecret}
"@
    [System.IO.File]::WriteAllText($configPath, $config, [System.Text.UTF8Encoding]::new($false))
    docker run --rm -d --name $containerName -p "127.0.0.1:${port}:7880" -p '127.0.0.1:7882:7882/udp' -v "${configPath}:/livekit.yaml:ro" $image --config /livekit.yaml | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not start the isolated LiveKit candidate server.' }
    $started = $true

    $ready = $false
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        try {
            if ((Invoke-WebRequest -Uri "http://127.0.0.1:${port}" -TimeoutSec 1).StatusCode -eq 200) { $ready = $true; break }
        } catch { }
        Start-Sleep -Milliseconds 500
    }
    if (-not $ready) { docker logs $containerName --tail 40; throw 'LiveKit candidate server did not become ready.' }

    $env:TOWN_E2E_BASE_URL = "http://localhost:${webPort}"
    $env:TOWN_E2E_MEDIA = 'true'
    $env:TOWN_E2E_LIVEKIT = 'true'
    $env:TOWN_LIVEKIT_SPIKE_URL = "ws://127.0.0.1:${port}"
    $env:TOWN_LIVEKIT_SPIKE_KEY = $spikeApiKey
    $env:TOWN_LIVEKIT_SPIKE_SECRET = $spikeSecret

    Push-Location $taskFrontend
    try {
        & pnpm exec playwright test tests/e2e/livekit-spike.spec.ts --reporter=line
        $testExit = $LASTEXITCODE
    } finally { Pop-Location }

    if ($testExit -ne 0) { docker logs $containerName --tail 60 }
} finally {
    if ($started) { docker stop $containerName | Out-Null }
    Remove-Item -LiteralPath $configPath -ErrorAction SilentlyContinue
    foreach ($name in $settingNames) { [Environment]::SetEnvironmentVariable($name, $previousSettings[$name], 'Process') }
}

exit $testExit
