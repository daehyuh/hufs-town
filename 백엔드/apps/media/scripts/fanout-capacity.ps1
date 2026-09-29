param(
  [ValidateRange(1, 99)][int]$Listeners = 99,
  [ValidateRange(2, 120)][int]$DurationSeconds = 8,
  [ValidateRange(1, 1000000)][int]$MinimumReceivedBytes = 5000,
  [ValidateRange(30, 900)][int]$TimeoutSeconds = 300
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$mediaDirectory = Join-Path $repoRoot 'apps\media'
$artifactDirectory = Join-Path $repoRoot '.build\media-fanout'
New-Item -ItemType Directory -Force -Path $artifactDirectory | Out-Null

$runId = '{0}-{1}-{2}' -f (Get-Date -Format 'yyyyMMdd-HHmmss-fff'), $PID, ([guid]::NewGuid().ToString('N').Substring(0, 8))
$containerName = "hufs-town-fanout-$runId"
$imageTag = "hufs-town-fanout:$runId"
$artifactPath = Join-Path $artifactDirectory "fanout-$runId.json"
$logPath = Join-Path $artifactDirectory "fanout-$runId.log"
$containerCreated = $false
$exitCode = $null
$failure = $null
$fanout = $null
$samples = [System.Collections.Generic.List[object]]::new()
$startedAt = Get-Date
$commandText = ".\apps\media\scripts\fanout-capacity.ps1 -Listeners $Listeners -DurationSeconds $DurationSeconds -MinimumReceivedBytes $MinimumReceivedBytes"

try {
  Write-Host "Building isolated SFU test image $imageTag"
  & docker build --file (Join-Path $mediaDirectory 'Dockerfile') --tag $imageTag $mediaDirectory
  if ($LASTEXITCODE -ne 0) { throw "Docker image build failed with exit code $LASTEXITCODE." }

  Write-Host "Starting a private loopback-only SFU test container ($($Listeners + 1) participants)."
  & docker run --detach --network none --cpus 2 --memory 1g --pids-limit 512 --name $containerName $imageTag node test/fanout-capacity.mjs --listeners $Listeners --duration-seconds $DurationSeconds --min-bytes $MinimumReceivedBytes
  if ($LASTEXITCODE -ne 0) { throw "Could not start the isolated test container (exit code $LASTEXITCODE)." }
  $containerCreated = $true

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $status = (& docker inspect --format '{{.State.Status}}' $containerName 2>$null | Select-Object -First 1)
    if ($LASTEXITCODE -ne 0) { throw 'The isolated test container disappeared before its result could be collected.' }
    if ($status -ne 'running') { break }

    $statLine = (& docker stats --no-stream --format '{{.CPUPerc}}|{{.MemUsage}}' $containerName 2>$null | Select-Object -First 1)
    if ($LASTEXITCODE -eq 0 -and $statLine -match '^\s*(?<cpu>[\d.]+)%\s*\|\s*(?<memory>[^|]+)') {
      $cpuPercent = [double]::Parse($Matches.cpu, [Globalization.CultureInfo]::InvariantCulture)
      $memoryText = $Matches.memory.Trim()
      $memoryMiB = $null
      if ($memoryText -match '^(?<used>[\d.]+)(?<unit>KiB|MiB|GiB|B)\s*/') {
        $amount = [double]::Parse($Matches.used, [Globalization.CultureInfo]::InvariantCulture)
        $memoryMiB = switch ($Matches.unit) {
          'B' { $amount / 1MB }
          'KiB' { $amount / 1KB }
          'MiB' { $amount }
          'GiB' { $amount * 1KB }
        }
      }
      $samples.Add([pscustomobject]@{
        at = (Get-Date).ToUniversalTime().ToString('o')
        cpuPercent = $cpuPercent
        memoryText = $memoryText
        memoryUsedMiB = $memoryMiB
      })
    }
    Start-Sleep -Seconds 1
  }

  $finalStatus = (& docker inspect --format '{{.State.Status}}' $containerName 2>$null | Select-Object -First 1)
  if ($finalStatus -eq 'running') {
    & docker kill $containerName | Out-Null
    throw "Capacity test exceeded its ${TimeoutSeconds}s timeout."
  }
  $exitCode = [int](& docker inspect --format '{{.State.ExitCode}}' $containerName)
  if ($LASTEXITCODE -ne 0) { throw 'Could not read the test container exit code.' }

  $logs = @(& docker logs $containerName 2>&1)
  if ($logs.Count) { $logs | ForEach-Object { $_.ToString() } | Set-Content -Path $logPath -Encoding utf8 }
  else { Set-Content -Path $logPath -Value '' -Encoding utf8 }
  $summaryLine = $logs | Where-Object { $_ -match '^MEDIA_FANOUT_SUMMARY ' } | Select-Object -Last 1
  if ($summaryLine) {
    $summaryJson = $summaryLine.Substring('MEDIA_FANOUT_SUMMARY '.Length)
    $fanout = $summaryJson | ConvertFrom-Json
  }
  if ($exitCode -ne 0) { throw "Fan-out harness failed with container exit code $exitCode." }
  if (-not $fanout) { throw 'The harness completed without emitting a machine-readable fan-out summary.' }
}
catch {
  $failure = $_.Exception.Message
}
finally {
  if ($containerCreated) {
    $logs = @(& docker logs $containerName 2>&1)
    if ($logs.Count) { $logs | ForEach-Object { $_.ToString() } | Set-Content -Path $logPath -Encoding utf8 }
    else { Set-Content -Path $logPath -Value '' -Encoding utf8 }
    if (-not $fanout) {
      $summaryLine = $logs | Where-Object { $_ -match '^MEDIA_FANOUT_SUMMARY ' } | Select-Object -Last 1
      if ($summaryLine) {
        try { $fanout = $summaryLine.Substring('MEDIA_FANOUT_SUMMARY '.Length) | ConvertFrom-Json } catch { }
      }
    }
    if ($null -eq $exitCode) {
      $observedExit = & docker inspect --format '{{.State.ExitCode}}' $containerName 2>$null
      if ($LASTEXITCODE -eq 0 -and $observedExit -match '^\d+$') { $exitCode = [int]$observedExit }
    }
    & docker rm --force $containerName | Out-Null
  }
  & docker image rm $imageTag 2>$null | Out-Null

  $usedMemorySamples = @($samples | Where-Object { $null -ne $_.memoryUsedMiB } | ForEach-Object { $_.memoryUsedMiB })
  $cpuSamples = @($samples | ForEach-Object { $_.cpuPercent })
  $peakCpuPercent = if ($cpuSamples.Count) { [Math]::Round(($cpuSamples | Measure-Object -Maximum).Maximum, 2) } else { $null }
  $dockerResources = [ordered]@{
    limits = @{ cpus = 2; memoryMiB = 1024; network = 'none (loopback only)' }
    sampleCount = $samples.Count
    peakDockerReportedCpuPercent = $peakCpuPercent
    peakCpuPercentOfLimit = if ($null -ne $peakCpuPercent) { [Math]::Round($peakCpuPercent / 2, 2) } else { $null }
    peakMemoryUsedMiB = if ($usedMemorySamples.Count) { [Math]::Round(($usedMemorySamples | Measure-Object -Maximum).Maximum, 2) } else { $null }
    samples = @($samples.ToArray())
  }
  $artifact = [ordered]@{
    schemaVersion = 1
    command = $commandText
    startedAt = $startedAt.ToUniversalTime().ToString('o')
    finishedAt = (Get-Date).ToUniversalTime().ToString('o')
    outcome = if ($failure) { 'failed' } elseif ($exitCode -eq 0 -and $fanout.rtp.allListenersMeetThreshold) { 'passed' } else { 'incomplete' }
    failure = $failure
    containerExitCode = $exitCode
    containerImage = $imageTag
    dockerResources = $dockerResources
    fanout = $fanout
    logFile = $logPath
    constraints = @(
      'The harness uses one publisher and N UDP/RTP listeners, with actual RTP packets routed through a mediasoup PlainTransport/router.',
      'It runs in a unique temporary Docker container using --network none; the primary and prior diagnostic containers are not modified.',
      'Plain RTP validates SFU packet fan-out and resource use, but does not validate browser WebRTC ICE/DTLS, camera encoding, or client decoding/rendering.'
    )
  }
  $artifact | ConvertTo-Json -Depth 16 | Set-Content -Path $artifactPath -Encoding utf8
}

if ($failure) { throw "$failure See artifact: $artifactPath" }
Write-Host "Fan-out capacity run passed: $($Listeners + 1) participants; all $Listeners listeners received at least $MinimumReceivedBytes RTP bytes."
Write-Host "Docker-reported CPU peak: $($dockerResources.peakDockerReportedCpuPercent)% (2-core quota); peak memory: $($dockerResources.peakMemoryUsedMiB) MiB of 1024 MiB."
Write-Host "Machine-readable result: $artifactPath"
Write-Host "Raw container log: $logPath"
