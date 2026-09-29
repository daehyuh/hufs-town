param(
    [ValidateSet(25, 50, 100)][int]$ClientCount = 100,
    [ValidateRange(0, 86400)][int]$WarmupSeconds = 0,
    [ValidateRange(1, 86400)][int]$SteadyStateSeconds = 15,
    [ValidateSet(1, 2, 4, 8, 16, 32, 64, 128)][int]$MaxJoinsPerTick = 8,
    [switch]$RecordJfr
)

$ErrorActionPreference = 'Stop'
$backendRoot = Split-Path $PSScriptRoot -Parent
$workspaceRoot = Split-Path $backendRoot -Parent
$summaryDir = Join-Path $workspaceRoot '.build/backend/world-load'
$jarDir = Join-Path $workspaceRoot '.build/backend/apps/world/libs'
$rawResultPath = Join-Path $summaryDir 'isolated-client.json'
$startedMarkerPath = "$rawResultPath.started"
$clientJvmPidPath = "$rawResultPath.client-pid"
$resourceSamplesPath = "$rawResultPath.samples.jsonl"
$summaryPath = Join-Path $summaryDir 'latest.json'
$clientOut = Join-Path $summaryDir 'client-gradle.stdout.log'
$clientErr = Join-Path $summaryDir 'client-gradle.stderr.log'
$serverOut = Join-Path $summaryDir 'world-server.stdout.log'
$serverErr = Join-Path $summaryDir 'world-server.stderr.log'
$jfrOutputPath = Join-Path $summaryDir 'world-load.jfr'
$jfrStatus = $null
$jfrSavedPath = $null
$jfrDumpAttempted = $false
if ($RecordJfr) {
    Remove-Item -LiteralPath $jfrOutputPath -Force -ErrorAction SilentlyContinue
    $jfrStatus = 'pending'
}
New-Item -ItemType Directory -Path $summaryDir -Force | Out-Null
Remove-Item -LiteralPath @($rawResultPath, $startedMarkerPath, $clientJvmPidPath, $resourceSamplesPath, $summaryPath) -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath @($clientOut, $clientErr, $serverOut, $serverErr) -Force -ErrorAction SilentlyContinue

$jdkCandidates = @($env:JAVA_HOME) + @(Get-ChildItem -LiteralPath "$env:USERPROFILE/.jdks" -Directory -ErrorAction SilentlyContinue | Where-Object Name -Match '21' | ForEach-Object FullName)
$taskJdk = $jdkCandidates | Where-Object { $_ -and (Test-Path -LiteralPath "$_/bin/java.exe") -and (Get-Content -LiteralPath "$_/release" -ErrorAction SilentlyContinue | Select-String 'JAVA_VERSION="21\.') } | Select-Object -First 1
if (-not $taskJdk) { throw 'JDK 21 is required; set JAVA_HOME to the installed JDK 21 directory.' }

$previousJava = $env:JAVA_HOME
$previousWorldLoadUrl = $env:HUFS_WORLD_LOAD_URL
$previousWorldLoadOutput = $env:HUFS_WORLD_LOAD_OUTPUT
$previousWorldLoadClientCount = $env:HUFS_WORLD_LOAD_CLIENT_COUNT
$previousWorldLoadWarmupSeconds = $env:HUFS_WORLD_LOAD_WARMUP_SECONDS
$previousWorldLoadSteadyStateSeconds = $env:HUFS_WORLD_LOAD_STEADY_STATE_SECONDS
$server = $null
$client = $null
$locationPushed = $false
$exitCode = 1

function Save-WorldJfrRecording {
    param(
        [System.Diagnostics.Process]$Process,
        [string]$JcmdPath,
        [string]$OutputPath
    )

    if (-not $Process) {
        return [pscustomobject]@{ Status = 'failed'; Path = $null; Detail = 'World process was not started.' }
    }
    $Process.Refresh()
    if ($Process.HasExited) {
        return [pscustomobject]@{ Status = 'failed'; Path = $null; Detail = 'World process exited before JFR.dump could run.' }
    }
    if (-not (Test-Path -LiteralPath $JcmdPath)) {
        return [pscustomobject]@{ Status = 'failed'; Path = $null; Detail = "jcmd was not found at $JcmdPath." }
    }

    $scrubbedOutputPath = Join-Path (Split-Path -Parent $OutputPath) `
        (([System.IO.Path]::GetFileNameWithoutExtension($OutputPath)) + '-scrubbed.jfr')
    try {
        $dumpOutput = @(& $JcmdPath $Process.Id 'JFR.dump' 'name=world-load' "filename=$OutputPath" 2>&1)
        $dumpExitCode = $LASTEXITCODE
        if ($dumpExitCode -eq 0 -and (Test-Path -LiteralPath $OutputPath)) {
            $jfrPath = Join-Path (Split-Path -Parent $JcmdPath) 'jfr.exe'
            Remove-Item -LiteralPath $scrubbedOutputPath -Force -ErrorAction SilentlyContinue
            $scrubOutput = @(& $jfrPath scrub --exclude-events 'jdk.InitialEnvironmentVariable,jdk.InitialSystemProperty' `
                $OutputPath $scrubbedOutputPath 2>&1)
            $scrubExitCode = $LASTEXITCODE
            if ($scrubExitCode -ne 0 -or -not (Test-Path -LiteralPath $scrubbedOutputPath)) {
                Remove-Item -LiteralPath $OutputPath -Force -ErrorAction SilentlyContinue
                Remove-Item -LiteralPath $scrubbedOutputPath -Force -ErrorAction SilentlyContinue
                return [pscustomobject]@{
                    Status = 'failed'; Path = $null
                    Detail = "JFR contained sensitive process environment metadata, and scrubbing failed: $($scrubOutput -join ' ')"
                }
            }
            Move-Item -LiteralPath $scrubbedOutputPath -Destination $OutputPath -Force
            return [pscustomobject]@{ Status = 'saved'; Path = $OutputPath; Detail = ($dumpOutput -join ' ') }
        }
        Remove-Item -LiteralPath $OutputPath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $scrubbedOutputPath -Force -ErrorAction SilentlyContinue
        return [pscustomobject]@{
            Status = 'failed'
            Path = $null
            Detail = "jcmd JFR.dump exited with code $dumpExitCode. $($dumpOutput -join ' ')"
        }
    } catch {
        Remove-Item -LiteralPath $OutputPath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $scrubbedOutputPath -Force -ErrorAction SilentlyContinue
        return [pscustomobject]@{ Status = 'failed'; Path = $null; Detail = $_.Exception.Message }
    }
}

try {
    $env:JAVA_HOME = $taskJdk
    Push-Location $backendRoot
    $locationPushed = $true

    & (Join-Path $PSScriptRoot 'gradle.ps1') ':apps:world:bootJar' '--console=plain'
    if ($LASTEXITCODE -ne 0) { throw "World bootJar build failed with exit code $LASTEXITCODE." }
    $jar = Get-ChildItem -LiteralPath $jarDir -Filter 'world-*.jar' -File |
        Where-Object { $_.Name -notlike '*-plain.jar' } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $jar) { throw "Packaged World executable jar was not produced in $jarDir." }

    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = $listener.LocalEndpoint.Port
    $listener.Stop()
    $baseUrl = "http://127.0.0.1:$port"
    $webSocketUrl = "ws://127.0.0.1:$port/world/socket?townMapId=isolated-load"

    $serverArguments = @(
        '-Xms128m', '-Xmx768m', '-jar', $jar.FullName,
        '--spring.profiles.active=preview',
        '--server.address=127.0.0.1', "--server.port=$port",
        '--town.auth.mode=preview', '--town.auth.preview-multimap-enabled=true',
        "--town.world.max-joins-per-tick=$MaxJoinsPerTick",
        '--town.public-origin=http://localhost:5173',
        '--management.endpoints.web.exposure.include=health,info,metrics'
    )
    $serverArgumentString = ($serverArguments | ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' }) -join ' '
    $server = Start-Process -FilePath (Join-Path $taskJdk 'bin/java.exe') -ArgumentList $serverArgumentString `
        -WorkingDirectory $backendRoot -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput $serverOut -RedirectStandardError $serverErr

    $healthUri = "$baseUrl/actuator/health"
    $ready = $false
    for ($attempt = 0; $attempt -lt 90; $attempt++) {
        $server.Refresh()
        if ($server.HasExited) { throw "Packaged World exited during startup (exit code $($server.ExitCode)); see $serverErr." }
        try {
            $health = Invoke-WebRequest -Uri $healthUri -TimeoutSec 2 -UseBasicParsing
            if ($health.StatusCode -eq 200) { $ready = $true; break }
        } catch { }
        Start-Sleep -Milliseconds 500
    }
    if (-not $ready) { throw "Packaged World did not become healthy at $healthUri; see $serverOut and $serverErr." }

    if ($RecordJfr) {
        # Start after Spring is healthy so diagnostic samples focus on the load
        # phases instead of spending most of the recording on JVM startup.
        $jcmdPath = Join-Path $taskJdk 'bin/jcmd.exe'
        $jfrStartOutput = @(& $jcmdPath $server.Id 'JFR.start' 'name=world-load' 'settings=profile' 'disk=true' 2>&1)
        if ($LASTEXITCODE -ne 0) {
            throw "Could not start the diagnostic JFR recording: $($jfrStartOutput -join ' ')"
        }
        Write-Output 'Diagnostic JFR recording started after the packaged World became healthy.'
    }

    $env:HUFS_WORLD_LOAD_URL = $webSocketUrl
    $env:HUFS_WORLD_LOAD_OUTPUT = $rawResultPath
    $env:HUFS_WORLD_LOAD_CLIENT_COUNT = [string]$ClientCount
    $env:HUFS_WORLD_LOAD_WARMUP_SECONDS = [string]$WarmupSeconds
    $env:HUFS_WORLD_LOAD_STEADY_STATE_SECONDS = [string]$SteadyStateSeconds
    $clientArguments = @(
        ':apps:world:test', '--tests', 'town.hufs.world.IsolatedWorldLoadTest',
        "-PworldLoadUrl=$webSocketUrl", "-PworldLoadOutput=$rawResultPath",
        "-PworldLoadClientCount=$ClientCount", "-PworldLoadWarmupSeconds=$WarmupSeconds",
        "-PworldLoadSteadyStateSeconds=$SteadyStateSeconds",
        '--console=plain', '--rerun-tasks'
    )
    $clientArgumentString = ($clientArguments | ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' }) -join ' '
    $client = Start-Process -FilePath (Join-Path $backendRoot 'gradlew.bat') -ArgumentList $clientArgumentString `
        -WorkingDirectory $backendRoot -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput $clientOut -RedirectStandardError $clientErr

    $cpuAtStart = $null
    $measurementStartedAt = $null
    $peakWorkingSetBytes = 0L
    $loadGeneratorPid = $null
    $loadGeneratorCpuAtStart = $null
    $loadGeneratorStartedAt = $null
    $loadGeneratorPeakWorkingSetBytes = 0L
    $loadGeneratorCpuAtEnd = $null
    while ($true) {
        $client.Refresh()
        if ($client.HasExited) { break }
        if (Test-Path -LiteralPath $startedMarkerPath) {
            if ($null -eq $cpuAtStart) {
                $serverProcess = Get-Process -Id $server.Id -ErrorAction Stop
                $cpuAtStart = $serverProcess.TotalProcessorTime.TotalSeconds
                $measurementStartedAt = [DateTime]::UtcNow
            }
            $serverProcess = Get-Process -Id $server.Id -ErrorAction SilentlyContinue
            if ($serverProcess) { $peakWorkingSetBytes = [Math]::Max($peakWorkingSetBytes, [long]$serverProcess.WorkingSet64) }
        }
        if (-not $loadGeneratorPid -and (Test-Path -LiteralPath $clientJvmPidPath)) {
            $loadGeneratorPid = [int](Get-Content -LiteralPath $clientJvmPidPath -Raw)
        }
        if ($loadGeneratorPid) {
            $loadGeneratorProcess = Get-Process -Id $loadGeneratorPid -ErrorAction SilentlyContinue
            if ($loadGeneratorProcess) {
                if ($null -eq $loadGeneratorCpuAtStart) {
                    $loadGeneratorCpuAtStart = $loadGeneratorProcess.TotalProcessorTime.TotalSeconds
                    $loadGeneratorStartedAt = [DateTime]::UtcNow
                }
                $loadGeneratorCpuAtEnd = $loadGeneratorProcess.TotalProcessorTime.TotalSeconds
                $loadGeneratorPeakWorkingSetBytes = [Math]::Max($loadGeneratorPeakWorkingSetBytes, [long]$loadGeneratorProcess.WorkingSet64)
            }
        }
        Start-Sleep -Milliseconds 200
    }
    $client.WaitForExit()
    if ($client.ExitCode -ne 0) {
        Get-Content -LiteralPath $clientOut -ErrorAction SilentlyContinue | Write-Output
        Get-Content -LiteralPath $clientErr -ErrorAction SilentlyContinue | Write-Output
        throw "Isolated WebSocket client run failed with exit code $($client.ExitCode)."
    }
    if (-not (Test-Path -LiteralPath $rawResultPath)) { throw 'Client process passed without writing its measurement JSON.' }

    $server.Refresh()
    if ($server.HasExited) { throw "World exited before measurements were collected (exit code $($server.ExitCode))." }
    $serverProcess = Get-Process -Id $server.Id -ErrorAction Stop
    $loadGeneratorProcess = if ($loadGeneratorPid) { Get-Process -Id $loadGeneratorPid -ErrorAction SilentlyContinue } else { $null }
    if ($loadGeneratorProcess) {
        $loadGeneratorCpuAtEnd = $loadGeneratorProcess.TotalProcessorTime.TotalSeconds
        $loadGeneratorPeakWorkingSetBytes = [Math]::Max($loadGeneratorPeakWorkingSetBytes, [long]$loadGeneratorProcess.WorkingSet64)
    }
    $measurementEndedAt = [DateTime]::UtcNow
    $cpuAtEnd = $serverProcess.TotalProcessorTime.TotalSeconds
    $elapsedSeconds = if ($measurementStartedAt) { ($measurementEndedAt - $measurementStartedAt).TotalSeconds } else { 0.0 }
    $serverCpuPercent = if ($null -ne $cpuAtStart -and $elapsedSeconds -gt 0) { ($cpuAtEnd - $cpuAtStart) * 100.0 / $elapsedSeconds } else { $null }
    $loadGeneratorElapsedSeconds = if ($loadGeneratorStartedAt) { ($measurementEndedAt - $loadGeneratorStartedAt).TotalSeconds } else { 0.0 }
    $loadGeneratorCpuPercent = if ($null -ne $loadGeneratorCpuAtStart -and $null -ne $loadGeneratorCpuAtEnd -and $loadGeneratorElapsedSeconds -gt 0) {
        ($loadGeneratorCpuAtEnd - $loadGeneratorCpuAtStart) * 100.0 / $loadGeneratorElapsedSeconds
    } else { $null }
    $rawResult = Get-Content -LiteralPath $rawResultPath -Raw | ConvertFrom-Json
    if ($RecordJfr -and -not $jfrDumpAttempted) {
        $jfrDumpAttempted = $true
        $jfrResult = Save-WorldJfrRecording -Process $server -JcmdPath (Join-Path $taskJdk 'bin/jcmd.exe') -OutputPath $jfrOutputPath
        $jfrStatus = $jfrResult.Status
        $jfrSavedPath = $jfrResult.Path
        if ($jfrStatus -eq 'failed') { Write-Warning "JFR diagnostic recording could not be saved: $($jfrResult.Detail)" }
    }
    $performanceCaveat = 'Preview-only WebSocket presence load: media fanout and production MariaDB/Redis runtime are not included'
    if ($RecordJfr) { $performanceCaveat += '; diagnostic JFR profiling is enabled and can perturb timings' }
    $summary = [ordered]@{
        runAtUtc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
        scope = "Packaged preview World bootJar in its own JVM; $ClientCount movement-enabled WebSocket clients run in Gradle test worker JVM"
        requestedClientCount = $ClientCount
        warmupSeconds = $WarmupSeconds
        steadyStateSeconds = $SteadyStateSeconds
        maxJoinsPerTick = $MaxJoinsPerTick
        serverPid = $server.Id
        serverJar = $jar.FullName
        serverAddress = "127.0.0.1:$port"
        serverMeasurementWindowSeconds = [Math]::Round($elapsedSeconds, 3)
        serverCpuPercentOfOneCore = if ($null -eq $serverCpuPercent) { $null } else { [Math]::Round($serverCpuPercent, 1) }
        serverWorkingSetPeakMiB = [Math]::Round($peakWorkingSetBytes / 1MB, 1)
        serverWorkingSetEndMiB = [Math]::Round($serverProcess.WorkingSet64 / 1MB, 1)
        serverCpuEndSeconds = [Math]::Round($cpuAtEnd, 3)
        loadGeneratorProcessId = $loadGeneratorPid
        loadGeneratorCpuPercentOfOneCore = if ($null -eq $rawResult.loadGeneratorCpuPercentOfOneCore) { $null } else { [Math]::Round($rawResult.loadGeneratorCpuPercentOfOneCore, 1) }
        loadGeneratorCpuMeasurement = 'Test JVM ProcessCpuTime delta over the complete client test interval'
        loadGeneratorWorkingSetPeakMiB = [Math]::Round($loadGeneratorPeakWorkingSetBytes / 1MB, 1)
        loadGeneratorWorkingSetEndMiB = if ($loadGeneratorProcess) { [Math]::Round($loadGeneratorProcess.WorkingSet64 / 1MB, 1) } else { $null }
        joinPhase50msOverrunGateMet = ($rawResult.joinPhase.tickOverrunsOver50ms -eq 0)
        steadyState50msOverrunGateMet = ($rawResult.steadyState.tickOverrunsOver50ms -eq 0)
        steadyStateP95Available = [bool]$rawResult.steadyState.tickP95Available
        joinPhaseTickMaxScope = $rawResult.joinPhase.tickMaxScope
        steadyStateTickMaxScope = $rawResult.steadyState.tickMaxScope
        steadyStateP95Scope = $rawResult.steadyState.tickP95Scope
        performanceCaveat = $performanceCaveat
        diagnosticRun = [bool]$RecordJfr
        jfrStatus = $jfrStatus
        jfrPath = $jfrSavedPath
        dockerWorldTargeted = $false
        actualMediaLoad = $false
        capacityResult = $rawResult
    }
    $summary | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $summaryPath -Encoding utf8

    $reportPath = Join-Path $workspaceRoot '.build/backend/apps/world/test-results/test/TEST-town.hufs.world.IsolatedWorldLoadTest.xml'
    if (-not (Test-Path -LiteralPath $reportPath)) { throw 'Isolated client JUnit report is missing.' }
    [xml]$report = Get-Content -LiteralPath $reportPath -Raw
    $testCase = @($report.testsuite.testcase | Where-Object { $_.name -like 'packagedWorldRunsConfiguredMovementLoadAndEnforcesCapacity*' } | Select-Object -First 1)
    if ($testCase.Count -ne 1 -or $testCase[0].failure -or $testCase[0].error -or $testCase[0].SelectSingleNode('skipped')) {
        throw "The isolated $ClientCount-client movement load test did not run successfully."
    }

    $exitCode = 0
    Write-Output "Packaged preview World, separate-process $ClientCount-client movement load: PASS"
    if ($RecordJfr) { Write-Output 'DIAGNOSTIC JFR run: profiling can perturb timings; capacity thresholds are unchanged.' }
    Write-Output ("Population: {0} joined clients converged; movement observed: {1}/{0}; inputs submitted: {2}" -f `
        $ClientCount, $rawResult.clientsObservedMoving, $rawResult.movementMessagesSubmitted)
    if ($ClientCount -eq 100) { Write-Output 'Capacity: client 101: FULL' }
    Write-Output ("Server process CPU: {0}% of one core; peak working set: {1:N1} MiB" -f $summary.serverCpuPercentOfOneCore, $summary.serverWorkingSetPeakMiB)
    Write-Output ("Load generator JVM CPU: {0}% of one core; peak working set: {1:N1} MiB" -f `
        $summary.loadGeneratorCpuPercentOfOneCore, $summary.loadGeneratorWorkingSetPeakMiB)
    Write-Output ("Join + overflow phase: {0} ms; {1} ticks, mean {2:N2} ms, {3} over 50 ms; max at phase end {4:N2} ms (may include startup)" -f `
        $rawResult.joinAndConvergenceMs, $rawResult.joinPhase.tickCount, $rawResult.joinPhase.tickMeanMs,
        $rawResult.joinPhase.tickOverrunsOver50ms, $rawResult.joinPhase.tickMaxMsAtPhaseEnd)
    Write-Output ("Movement steady state: warmup {0} s + {1:N2} s; {2} ticks, mean {3:N2} ms, {4} over 50 ms; max at phase end {5:N2} ms" -f `
        $rawResult.steadyState.warmupDurationSeconds, `
        ($rawResult.steadyState.measuredDurationMs / 1000.0), $rawResult.steadyState.tickCount,
        $rawResult.steadyState.tickMeanMs, $rawResult.steadyState.tickOverrunsOver50ms,
        $rawResult.steadyState.tickMaxMsAtPhaseEnd)
    if ($rawResult.steadyState.tickP95Available) {
        Write-Output ("Steady-state p95 gauge: {0:N2} ms; scope: {1}" -f $rawResult.steadyState.tickP95Ms, $rawResult.steadyState.tickP95Scope)
    } else {
        Write-Output 'Steady-state p95: unavailable from the queried actuator metric; no p95 criterion claimed.'
    }
    Write-Output ("50 ms overrun gates: join={0}; steady-state={1}" -f `
        $(if ($summary.joinPhase50msOverrunGateMet) { 'PASS' } else { 'NOT MET' }),
        $(if ($summary.steadyState50msOverrunGateMet) { 'PASS' } else { 'NOT MET' }))
    Write-Output ("Client connect: {0} ms; population convergence: {1} ms; queue after steady state: {2}/{3}; heap: {4:N1} MiB" -f `
        $rawResult.connectMs, $rawResult.joinAndConvergenceMs, $rawResult.steadyState.commandQueueSizeAtPhaseEnd,
        $rawResult.commandQueueCapacity, ($rawResult.steadyState.serverHeapUsedBytesAtPhaseEnd / 1MB))
    Write-Output ("Machine-readable run summary: {0}" -f $summaryPath)
    if ($RecordJfr) {
        if ($jfrStatus -eq 'saved') {
            Write-Output ("JFR diagnostic recording: saved to {0}" -f $jfrSavedPath)
        } else {
            Write-Output ("JFR diagnostic recording status: {0}; see warning above." -f $jfrStatus)
        }
    }
} catch {
    Write-Error $_
    if (Test-Path -LiteralPath $clientOut) { Get-Content -LiteralPath $clientOut -ErrorAction SilentlyContinue | Write-Output }
    if (Test-Path -LiteralPath $clientErr) { Get-Content -LiteralPath $clientErr -ErrorAction SilentlyContinue | Write-Output }
} finally {
    if ($client) {
        $client.Refresh()
        if (-not $client.HasExited) { Stop-Process -Id $client.Id -Force -ErrorAction SilentlyContinue }
    }
    if ($RecordJfr -and -not $jfrDumpAttempted) {
        $jfrDumpAttempted = $true
        $jfrResult = Save-WorldJfrRecording -Process $server -JcmdPath (Join-Path $taskJdk 'bin/jcmd.exe') -OutputPath $jfrOutputPath
        $jfrStatus = $jfrResult.Status
        $jfrSavedPath = $jfrResult.Path
        if ($jfrStatus -eq 'failed') { Write-Warning "JFR diagnostic recording could not be saved before shutdown: $($jfrResult.Detail)" }
        if (Test-Path -LiteralPath $summaryPath) {
            $existingSummary = Get-Content -LiteralPath $summaryPath -Raw | ConvertFrom-Json
            $existingSummary.jfrStatus = $jfrStatus
            $existingSummary.jfrPath = $jfrSavedPath
            $existingSummary.diagnosticRun = [bool]$RecordJfr
            if ($existingSummary.performanceCaveat -notlike '*diagnostic JFR profiling*') {
                $existingSummary.performanceCaveat += '; diagnostic JFR profiling is enabled and can perturb timings'
            }
            $existingSummary | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $summaryPath -Encoding utf8
        } elseif ($RecordJfr) {
            [ordered]@{
                runAtUtc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
                diagnosticRun = $true
                performanceCaveat = 'Diagnostic JFR profiling is enabled and can perturb timings; this failed load run is not capacity evidence.'
                jfrStatus = $jfrStatus
                jfrPath = $jfrSavedPath
            } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $summaryPath -Encoding utf8
        }
    }
    if ($server) {
        $server.Refresh()
        if (-not $server.HasExited) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
    }
    if ($locationPushed) { Pop-Location }
    $env:JAVA_HOME = $previousJava
    $env:HUFS_WORLD_LOAD_URL = $previousWorldLoadUrl
    $env:HUFS_WORLD_LOAD_OUTPUT = $previousWorldLoadOutput
    $env:HUFS_WORLD_LOAD_CLIENT_COUNT = $previousWorldLoadClientCount
    $env:HUFS_WORLD_LOAD_WARMUP_SECONDS = $previousWorldLoadWarmupSeconds
    $env:HUFS_WORLD_LOAD_STEADY_STATE_SECONDS = $previousWorldLoadSteadyStateSeconds
}
exit $exitCode
