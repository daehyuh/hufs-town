param(
    [ValidateSet(25, 50, 100)][int]$ClientCount = 100,
    [ValidateRange(0, 86400)][int]$WarmupSeconds = 0,
    [ValidateRange(1, 86400)][int]$SteadyStateSeconds = 15,
    [ValidateRange(1024, 65535)][int]$HostPort = 18092,
    [ValidateSet(1, 2, 4, 8, 16, 32, 64, 128)][int]$MaxJoinsPerTick = 8,
    [ValidateSet(2, 4, 8, 16)][int]$SendThreads = 4,
    [ValidateRange(0.0, 64.0)][double]$CpuLimit = 0.0,
    [ValidateRange(0, 1048576)][int]$MemoryLimitMiB = 0,
    [switch]$RecordJfr
)

$ErrorActionPreference = 'Stop'
$backendRoot = Split-Path $PSScriptRoot -Parent
$workspaceRoot = Split-Path $backendRoot -Parent
$summaryDir = Join-Path $workspaceRoot '.build/backend/world-load'
$rawResultPath = Join-Path $summaryDir 'docker-client.json'
$dockerSamplesPath = Join-Path $summaryDir 'docker-world-stats.txt'
$summaryPath = Join-Path $summaryDir 'docker-latest.json'
$gradleLogPath = Join-Path $summaryDir 'docker-world-load-gradle.log'
$jfrPath = Join-Path $summaryDir 'docker-world-load.jfr'
$containerName = "hufs-town-world-load-$PID"
$worldImage = "hufs-town-world-load-$PID"
$dockerfilePath = Join-Path $backendRoot 'infra/Dockerfile.jvm'
$statsJob = $null
$containerStarted = $false
$imageBuilt = $false
$locationPushed = $false
$previousJava = $env:JAVA_HOME

New-Item -ItemType Directory -Path $summaryDir -Force | Out-Null
Remove-Item -LiteralPath @($rawResultPath, "$rawResultPath.started", "$rawResultPath.client-pid", $dockerSamplesPath, $summaryPath, $gradleLogPath) -Force -ErrorAction SilentlyContinue
if ($RecordJfr) { Remove-Item -LiteralPath $jfrPath -Force -ErrorAction SilentlyContinue }

try {
    Push-Location $backendRoot
    $locationPushed = $true
    $jdkCandidates = @($env:JAVA_HOME) + @(Get-ChildItem -LiteralPath "$env:USERPROFILE/.jdks" -Directory -ErrorAction SilentlyContinue | Where-Object Name -Match '21' | ForEach-Object FullName)
    $taskJdk = $jdkCandidates | Where-Object { $_ -and (Test-Path -LiteralPath "$_/bin/java.exe") -and (Get-Content -LiteralPath "$_/release" -ErrorAction SilentlyContinue | Select-String 'JAVA_VERSION="21\.') } | Select-Object -First 1
    if (-not $taskJdk) { throw 'JDK 21 is required; set JAVA_HOME to the installed JDK 21 directory.' }
    $env:JAVA_HOME = $taskJdk
    & docker build --tag $worldImage --build-arg APP_NAME=world --file $dockerfilePath $backendRoot
    if ($LASTEXITCODE -ne 0) { throw 'Docker World image build failed.' }
    $imageBuilt = $true

    $worldRunArgs = @(
        'run', '-d', '--name', $containerName,
        '-p', "127.0.0.1:${HostPort}:18081",
        '-e', 'SERVER_ADDRESS=0.0.0.0',
        '-e', 'TOWN_AUTH_MODE=preview',
        '-e', 'TOWN_AUTH_PREVIEW_MULTIMAP_ENABLED=true',
        '-e', 'TOWN_MEDIA_ENABLED=false',
        '-e', "TOWN_WORLD_MAX_JOINS_PER_TICK=$MaxJoinsPerTick",
        '-e', "TOWN_WORLD_SEND_THREADS=$SendThreads"
    )
    if ($CpuLimit -gt 0) {
        $taskInvariantCpuLimit = $CpuLimit.ToString([Globalization.CultureInfo]::InvariantCulture)
        $worldRunArgs += @('--cpus', $taskInvariantCpuLimit)
    }
    if ($MemoryLimitMiB -gt 0) {
        $worldRunArgs += @('--memory', "${MemoryLimitMiB}m")
    }
    if ($RecordJfr) {
        $worldRunArgs += @('-e', 'JAVA_TOOL_OPTIONS=-XX:MaxRAMPercentage=75.0 -Dfile.encoding=UTF-8 -XX:StartFlightRecording=name=world-load,settings=profile,disk=true,filename=/tmp/world-load.jfr')
    }
    # Start only the disposable preview target; do not start or recreate API/DB/Redis services.
    $worldRunArgs += @($worldImage, '--spring.profiles.active=preview')
    & docker @worldRunArgs
    if ($LASTEXITCODE -ne 0) { throw 'Docker World load target could not be started.' }
    $containerStarted = $true

    $worldBaseUrl = "http://127.0.0.1:$HostPort"
    $worldReady = $false
    for ($attempt = 0; $attempt -lt 90; $attempt++) {
        $running = & docker inspect --format '{{.State.Running}}' $containerName 2>$null
        if ($LASTEXITCODE -ne 0 -or $running -ne 'true') {
            & docker logs --tail 80 $containerName
            throw 'Docker World exited during startup.'
        }
        try {
            $worldHealth = Invoke-RestMethod -Uri "$worldBaseUrl/actuator/health" -TimeoutSec 2
            if ($worldHealth.status -eq 'UP') { $worldReady = $true; break }
        } catch { }
        Start-Sleep -Seconds 1
    }
    if (-not $worldReady) { throw "Docker World did not become healthy at $worldBaseUrl." }

    $statsJob = Start-Job -ArgumentList $containerName, $dockerSamplesPath -ScriptBlock {
        param($Name, $OutputPath)
        while ($true) {
            $sample = & docker stats --no-stream --format '{{.CPUPerc}}|{{.MemUsage}}' $Name 2>$null
            if ($LASTEXITCODE -ne 0) { break }
            Add-Content -LiteralPath $OutputPath -Value $sample
            Start-Sleep -Seconds 1
        }
    }

    $webSocketUrl = "ws://127.0.0.1:$HostPort/world/socket?townMapId=docker-load"
    $clientArgs = @(
        '--no-daemon', '--console=plain', ':apps:world:test', '--tests', 'town.hufs.world.IsolatedWorldLoadTest',
        "-PworldLoadUrl=$webSocketUrl", "-PworldLoadOutput=$rawResultPath",
        "-PworldLoadClientCount=$ClientCount", "-PworldLoadWarmupSeconds=$WarmupSeconds",
        "-PworldLoadSteadyStateSeconds=$SteadyStateSeconds", '--rerun-tasks'
    )
    & (Join-Path $backendRoot 'gradlew.bat') @clientArgs *>&1 | Tee-Object -FilePath $gradleLogPath
    if ($LASTEXITCODE -ne 0) { throw "Docker World $ClientCount-client movement load failed." }
    if (-not (Test-Path -LiteralPath $rawResultPath)) { throw 'Docker World load test produced no measurement JSON.' }

    Stop-Job -Job $statsJob -ErrorAction SilentlyContinue
    Receive-Job -Job $statsJob -ErrorAction SilentlyContinue | Out-Null
    Remove-Job -Job $statsJob -Force -ErrorAction SilentlyContinue
    $statsJob = $null

    if ($RecordJfr) {
        & docker stop --time 15 $containerName | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Docker World did not stop cleanly after the diagnostic run.' }
        & docker cp "${containerName}:/tmp/world-load.jfr" $jfrPath
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $jfrPath)) { throw 'JFR recording could not be copied from Docker World.' }
    }

    $stats = @(Get-Content -LiteralPath $dockerSamplesPath -ErrorAction SilentlyContinue | ForEach-Object {
        if ($_ -match '^\s*([\d.]+)%\|\s*([\d.]+)(B|KiB|MiB|GiB)\s*/') {
            $memoryMiB = [double]$Matches[2]
            switch ($Matches[3]) {
                'B' { $memoryMiB /= 1MB }
                'KiB' { $memoryMiB /= 1024 }
                'GiB' { $memoryMiB *= 1024 }
            }
            [pscustomobject]@{ CpuPercent = [double]$Matches[1]; MemoryMiB = $memoryMiB }
        }
    })
    if ($stats.Count -eq 0) { throw 'Docker World resource samples are missing or could not be parsed.' }

    $loadResult = Get-Content -LiteralPath $rawResultPath -Raw | ConvertFrom-Json
    $summary = [ordered]@{
        runAtUtc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
        scope = "Isolated Docker preview World; $ClientCount movement-enabled WebSocket clients"
        dockerWorldTargeted = $true
        worldHealth = $worldHealth.status
        hostPort = $HostPort
        maxJoinsPerTick = $MaxJoinsPerTick
        sendThreads = $SendThreads
        dockerWorldCpuLimitCores = if ($CpuLimit -gt 0) { $CpuLimit } else { $null }
        dockerWorldMemoryLimitMiB = if ($MemoryLimitMiB -gt 0) { $MemoryLimitMiB } else { $null }
        isolatedImageBuilt = $imageBuilt
        dockerWorldCpuPeakPercent = [Math]::Round(($stats | Measure-Object -Property CpuPercent -Maximum).Maximum, 1)
        dockerWorldWorkingSetPeakMiB = [Math]::Round(($stats | Measure-Object -Property MemoryMiB -Maximum).Maximum, 1)
        dockerResourceSampleCount = $stats.Count
        actualMediaLoad = $false
        diagnosticRun = [bool]$RecordJfr
        jfrPath = if ($RecordJfr) { $jfrPath } else { $null }
        capacityResult = $loadResult
    }
    $summary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $summaryPath -Encoding utf8

    $reportPath = Join-Path $workspaceRoot '.build/backend/apps/world/test-results/test/TEST-town.hufs.world.IsolatedWorldLoadTest.xml'
    if (-not (Test-Path -LiteralPath $reportPath)) { throw 'Docker World load-test JUnit report is missing.' }
    [xml]$report = Get-Content -LiteralPath $reportPath -Raw
    $testCase = @($report.testsuite.testcase | Where-Object { $_.name -like 'packagedWorldRunsConfiguredMovementLoadAndEnforcesCapacity*' } | Select-Object -First 1)
    if ($testCase.Count -ne 1 -or $testCase[0].failure -or $testCase[0].error -or $testCase[0].SelectSingleNode('skipped')) {
        throw 'The Docker World movement load test did not run successfully.'
    }

    Write-Output "Isolated Docker preview World, $ClientCount-client movement load: PASS"
    Write-Output "Population: $($loadResult.acceptedClients) joined; movement observed: $($loadResult.clientsObservedMoving)/$ClientCount; overflow: $($loadResult.overflowClientCode)"
    Write-Output "Session send workers: $SendThreads"
    Write-Output "Docker World peak CPU: $($summary.dockerWorldCpuPeakPercent)% of one core; peak memory: $($summary.dockerWorldWorkingSetPeakMiB) MiB"
    if ($CpuLimit -gt 0 -or $MemoryLimitMiB -gt 0) {
        $taskCpuLimitLabel = if ($CpuLimit -gt 0) { $CpuLimit } else { 'unlimited' }
        $taskMemoryLimitLabel = if ($MemoryLimitMiB -gt 0) { $MemoryLimitMiB } else { 'unlimited' }
        Write-Output "Container limits: CPU $taskCpuLimitLabel; memory $taskMemoryLimitLabel MiB"
    }
    Write-Output "Machine-readable run summary: $summaryPath"
    if ($RecordJfr) { Write-Output "Diagnostic JFR recording: $jfrPath (profiling can perturb timings)" }
} catch {
    Write-Error $_
    Get-Content -LiteralPath $gradleLogPath -ErrorAction SilentlyContinue | Write-Output
    throw
} finally {
    if ($statsJob) {
        Stop-Job -Job $statsJob -ErrorAction SilentlyContinue
        Remove-Job -Job $statsJob -Force -ErrorAction SilentlyContinue
    }
    if ($containerStarted) {
        & docker rm -f $containerName 2>$null | Out-Null
    }
    if ($imageBuilt) {
        & docker image rm $worldImage 2>$null | Out-Null
    }
    if ($locationPushed) { Pop-Location }
    $env:JAVA_HOME = $previousJava
}
