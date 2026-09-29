param(
    [ValidateSet('start','stop','status')][string]$Action = 'start',
    [ValidateSet('preview','local')][string]$Profile = 'local',
    [switch]$SkipBuild,
    [switch]$TailnetPreview,
    [switch]$TailnetHttpsPreview
)
$ErrorActionPreference = 'Stop'
$taskBackend = Split-Path $PSScriptRoot -Parent
$taskRoot = Split-Path $taskBackend -Parent
$taskFrontend = Join-Path $taskRoot '프론트'
$taskRuntime = Join-Path $taskRoot '.local/hufs-town'
$taskStateFile = Join-Path $taskRuntime 'processes.json'
$taskTailnetStateFile = Join-Path $taskRuntime 'tailnet-https-preview.json'
New-Item -ItemType Directory -Force -Path $taskRuntime | Out-Null
$taskEntries = if (Test-Path -LiteralPath $taskStateFile) { @(Get-Content -Raw -LiteralPath $taskStateFile | ConvertFrom-Json) } else { @() }
function Get-OwnedProcess($Entry) {
    $candidate = Get-Process -Id $Entry.Id -ErrorAction SilentlyContinue
    if ($candidate -and $candidate.StartTime.ToUniversalTime().Ticks.ToString() -eq $Entry.StartTicks) { return $candidate }
    return $null
}
function Get-TailscaleServeConfig {
    $taskTailscale = Get-Command tailscale -ErrorAction SilentlyContinue
    if (-not $taskTailscale) { throw 'Tailscale CLI is required to manage the secure preview.' }
    $taskConfigText = (& $taskTailscale.Source serve get-config --all 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Could not read the current Tailscale Serve configuration.' }
    try { $taskConfig = $taskConfigText | ConvertFrom-Json } catch { throw 'Tailscale returned an unreadable Serve configuration.' }
    $taskConfigured = $false
    foreach ($taskProperty in $taskConfig.PSObject.Properties) {
        if ($taskProperty.Name -eq 'version' -or $null -eq $taskProperty.Value) { continue }
        if ($taskProperty.Value -is [System.Collections.IDictionary]) {
            if ($taskProperty.Value.Count -gt 0) { $taskConfigured = $true; break }
        } elseif ($taskProperty.Value -is [array]) {
            if ($taskProperty.Value.Count -gt 0) { $taskConfigured = $true; break }
        } elseif ($taskProperty.Value -is [string]) {
            if (-not [string]::IsNullOrWhiteSpace($taskProperty.Value)) { $taskConfigured = $true; break }
        } elseif ($taskProperty.Value.PSObject.Properties.Count -gt 0) {
            $taskConfigured = $true; break
        }
    }
    return [pscustomobject]@{ Text=$taskConfigText; Configured=$taskConfigured }
}
function Get-TownFingerprint([string]$Text) {
    $taskSha = [Security.Cryptography.SHA256]::Create()
    try { return [Convert]::ToHexString($taskSha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text))) }
    finally { $taskSha.Dispose() }
}
function Remove-OwnedTailnetServe($State) {
    if (-not $State) { return $true }
    $taskCurrentConfig = Get-TailscaleServeConfig
    $taskCurrentFingerprint = Get-TownFingerprint $taskCurrentConfig.Text
    if (-not $State.ConfigFingerprint -and $taskCurrentFingerprint -eq $State.BaselineFingerprint) {
        Remove-Item -LiteralPath $taskTailnetStateFile -Force -ErrorAction SilentlyContinue
        return $true
    }
    if (-not $State.ConfigFingerprint -or $taskCurrentFingerprint -ne $State.ConfigFingerprint) {
        Write-Warning 'Tailscale Serve changed after HUFS Town started. Keeping the current configuration; remove the saved preview state after reviewing tailscale serve status.'
        return $false
    }
    $taskTailscale = Get-Command tailscale -ErrorAction Stop
    & $taskTailscale.Source serve reset | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not remove the HUFS Town Tailscale Serve route.' }
    Remove-Item -LiteralPath $taskTailnetStateFile -Force -ErrorAction SilentlyContinue
    return $true
}
function Test-OwnedTailnetServe($State) {
    if (-not $State -or -not $State.ConfigFingerprint) { return $false }
    try {
        $taskCurrentConfig = Get-TailscaleServeConfig
        if (-not $taskCurrentConfig.Configured) { return $false }
        if ((Get-TownFingerprint $taskCurrentConfig.Text) -ne $State.ConfigFingerprint) { return $false }
        Invoke-WebRequest -Uri "$($State.Origin)/" -UseBasicParsing -TimeoutSec 3 | Out-Null
        return $true
    } catch {
        return $false
    }
}
if ($Action -eq 'status') {
    foreach ($entry in $taskEntries) { [pscustomobject]@{ Name=$entry.Name; Running=[bool](Get-OwnedProcess $entry); Port=$entry.Port } }
    if (Test-Path -LiteralPath $taskTailnetStateFile) {
        $taskSecureState=Get-Content -Raw -LiteralPath $taskTailnetStateFile | ConvertFrom-Json
        [pscustomobject]@{ Name='tailnet-https-preview'; Running=[bool](Test-OwnedTailnetServe $taskSecureState); Port=443; Url=$taskSecureState.Origin }
    }
    exit 0
}
if ($Action -eq 'stop') {
    $taskSecureState = if (Test-Path -LiteralPath $taskTailnetStateFile) { Get-Content -Raw -LiteralPath $taskTailnetStateFile | ConvertFrom-Json } else { $null }
    $taskServeRemoved = $true
    if ($taskSecureState) { $taskServeRemoved = Remove-OwnedTailnetServe $taskSecureState }
    foreach ($entry in $taskEntries) { $owned = Get-OwnedProcess $entry; if ($owned) { Stop-Process -InputObject $owned } }
    '[]' | Set-Content -LiteralPath $taskStateFile -Encoding utf8
    if ($taskSecureState) {
        & "$PSScriptRoot/media.ps1" stop -TailnetAddress $taskSecureState.TailnetAddress -ControlHostPort $taskSecureState.MediaControlPort -RtcPort $taskSecureState.MediaRtcPort -DedicatedTailnetPreview
        if ($LASTEXITCODE -ne 0) { throw 'Could not stop the isolated tailnet preview media service.' }
        if ($taskServeRemoved) { Remove-Item -LiteralPath $taskTailnetStateFile -Force -ErrorAction SilentlyContinue }
    }
    Write-Output 'HUFS Town development processes stopped.'
    exit 0
}
$taskAllowedSettings = @('DB_URL','DB_USER','DB_PASSWORD','REDIS_HOST','REDIS_PORT','TOWN_MEDIA_ENABLED','MEDIA_CONTROL_URL','MEDIA_CONTROL_TOKEN','MEDIA_ANNOUNCED_ADDRESS','MEDIA_RTC_BIND_ADDRESS','MEDIA_RTC_PORT','MEDIA_CONTROL_BIND_ADDRESS','MEDIA_CONTROL_HOST_PORT','TOWN_AUTH_MODE','TOWN_PUBLIC_ORIGIN','TOWN_ALLOWED_ORIGINS','TOWN_WORLD_ENDPOINTS','TOWN_COOKIE_SECURE','TOWN_WEB_PUSH_PUBLIC_KEY','TOWN_WEB_PUSH_PRIVATE_KEY','TOWN_WEB_PUSH_SUBJECT','TOWN_ADMIN_USER_IDS','HUFS_SSO_CLIENT_ID','HUFS_SSO_CLIENT_SECRET','HUFS_SSO_REDIRECT_URI','HUFS_SSO_AUTHORIZE_URL','HUFS_SSO_USERINFO_URL')
# Parse only literal KEY=value entries; never execute dotenv content or print secrets.
# Explicit process environment wins, then backend/.env, legacy .env.local, then infra/.env.
foreach ($taskEnvFile in @("$taskBackend/.env", "$taskBackend/.env.local", "$taskBackend/infra/.env")) {
    if (-not (Test-Path -LiteralPath $taskEnvFile)) { continue }
    foreach ($taskLine in Get-Content -LiteralPath $taskEnvFile -Encoding utf8) {
        if ($taskLine.Trim() -match '^([A-Z][A-Z0-9_]*)=(.*)$') {
            $taskKey = $Matches[1]
            $taskValue = $Matches[2].Trim()
            if ($taskAllowedSettings -notcontains $taskKey) { continue }
            if ($taskValue.Length -ge 2 -and (($taskValue.StartsWith('"') -and $taskValue.EndsWith('"')) -or ($taskValue.StartsWith("'") -and $taskValue.EndsWith("'")))) {
                $taskValue = $taskValue.Substring(1, $taskValue.Length - 2)
            }
            if ($taskValue -and -not [Environment]::GetEnvironmentVariable($taskKey, 'Process')) {
                [Environment]::SetEnvironmentVariable($taskKey, $taskValue, 'Process')
            }
        }
    }
}
if ($TailnetPreview -and $TailnetHttpsPreview) { throw 'Choose only one of -TailnetPreview or -TailnetHttpsPreview.' }
if ($TailnetPreview -or $TailnetHttpsPreview) {
    if ($Action -ne 'start' -or $Profile -ne 'preview') { throw 'Tailnet previews require start with -Profile preview.' }
    $taskTailscale = Get-Command tailscale -ErrorAction SilentlyContinue
    if (-not $taskTailscale) { throw 'Tailscale CLI is required for a tailnet preview.' }
    $taskTailnetAddressText = (& $taskTailscale.Source ip -4 | Select-Object -First 1).Trim()
    $taskTailnetAddress = [System.Net.IPAddress]::Parse($taskTailnetAddressText)
    $taskAddressBytes = $taskTailnetAddress.GetAddressBytes()
    if ($taskTailnetAddress.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork -or $taskAddressBytes[0] -ne 100 -or $taskAddressBytes[1] -lt 64 -or $taskAddressBytes[1] -gt 127) {
        throw 'Tailscale did not return an IPv4 address in 100.64.0.0/10.'
    }
    $taskTailnetAddress = $taskTailnetAddress.ToString()
    if ($TailnetHttpsPreview) {
        if (Test-Path -LiteralPath $taskTailnetStateFile) { throw 'A secure tailnet preview state already exists. Run scripts/dev.ps1 stop first.' }
        $taskStatusText = (& $taskTailscale.Source status --json 2>&1 | Out-String)
        if ($LASTEXITCODE -ne 0) { throw 'Tailscale is not connected.' }
        try { $taskTailnetStatus = $taskStatusText | ConvertFrom-Json } catch { throw 'Could not read the Tailscale device name.' }
        $taskTailnetDns = ([string]$taskTailnetStatus.Self.DNSName).TrimEnd('.')
        if (-not $taskTailnetDns.EndsWith('.ts.net',[StringComparison]::OrdinalIgnoreCase)) { throw 'Tailscale did not provide a MagicDNS HTTPS name for this device.' }
        $taskServeConfig = Get-TailscaleServeConfig
        if ($taskServeConfig.Configured) { throw 'Tailscale Serve already has routes. Stop or preserve them before starting the HUFS Town secure preview.' }
        $taskWebBind = '127.0.0.1'
        $taskWebOrigin = "https://$taskTailnetDns"
        $env:TOWN_PUBLIC_ORIGIN = $taskWebOrigin
        $taskOrigins = [System.Collections.Generic.List[string]]::new()
        foreach ($taskOrigin in ($env:TOWN_ALLOWED_ORIGINS -split ',')) {
            $taskOrigin = $taskOrigin.Trim()
            if ($taskOrigin -and -not $taskOrigins.Contains($taskOrigin)) { $taskOrigins.Add($taskOrigin) }
        }
        if (-not $taskOrigins.Contains($taskWebOrigin)) { $taskOrigins.Add($taskWebOrigin) }
        $env:TOWN_ALLOWED_ORIGINS = $taskOrigins -join ','
        $env:TOWN_WORLD_ENDPOINTS = ''
        $env:TOWN_AUTH_MODE = 'preview'
        $env:TOWN_COOKIE_SECURE = 'true'
        $env:TOWN_MEDIA_ENABLED = 'true'
        $env:MEDIA_CONTROL_URL = 'http://127.0.0.1:18088'
        $env:MEDIA_ANNOUNCED_ADDRESS = $taskTailnetAddress
        $env:MEDIA_RTC_BIND_ADDRESS = $taskTailnetAddress
        $env:MEDIA_RTC_PORT = '44446'
        $env:MEDIA_CONTROL_BIND_ADDRESS = '127.0.0.1'
        $env:MEDIA_CONTROL_HOST_PORT = '18088'
        $env:TOWN_API_TARGET = 'http://127.0.0.1:18084'
        $env:TOWN_WORLD_TARGET = 'http://127.0.0.1:18085'
        $env:TOWN_VITE_ALLOWED_HOSTS = $taskTailnetDns
        $env:HUFS_SSO_CLIENT_ID = ''
        $env:HUFS_SSO_CLIENT_SECRET = ''
    } else {
        $taskWebBind = $taskTailnetAddress
        $taskWebOrigin = "http://${taskWebBind}:5173"
        # Plain HTTP is an anonymous UI preview only; browsers disable camera, microphone, and screen capture on this origin.
        $env:TOWN_PUBLIC_ORIGIN = $taskWebOrigin
        $env:TOWN_AUTH_MODE = 'preview'
        $env:TOWN_COOKIE_SECURE = 'false'
        $env:TOWN_MEDIA_ENABLED = 'false'
        $env:HUFS_SSO_CLIENT_ID = ''
        $env:HUFS_SSO_CLIENT_SECRET = ''
        $env:MEDIA_CONTROL_TOKEN = ''
    }
    # Both tailnet modes are anonymous and keep SSO credentials off tailnet listeners.
} else {
    $taskWebOrigin = if ($env:TOWN_PUBLIC_ORIGIN) { $env:TOWN_PUBLIC_ORIGIN } else { 'http://localhost:5173' }
    $taskWebUri = [Uri]$taskWebOrigin
    if ($taskWebUri.Scheme -ne 'http' -or $taskWebUri.Host -notin @('localhost','127.0.0.1')) { throw 'The dev launcher requires an HTTP localhost or 127.0.0.1 public origin. Use a tailnet preview switch for a private tailnet view.' }
    # localhost resolves to ::1 first on this machine; bind explicitly so another IPv4-only app can keep its own port.
    $taskWebBind = if ($taskWebUri.Host -eq 'localhost') { '::1' } else { '127.0.0.1' }
}
$taskWebUri = [Uri]$taskWebOrigin
$taskWebPort = if ($TailnetHttpsPreview) { 5174 } else { $taskWebUri.Port }
$taskApiPort = if ($TailnetHttpsPreview) { 18084 } else { 18080 }
$taskWorldPort = if ($TailnetHttpsPreview) { 18085 } else { 18081 }
$taskApiManagementPort = if ($TailnetHttpsPreview) { 18086 } else { 18082 }
$taskWorldManagementPort = if ($TailnetHttpsPreview) { 18087 } else { 18083 }
$taskMediaControlPort = if ($TailnetHttpsPreview) { 18088 } else { 18082 }
$taskMediaRtcPort = if ($TailnetHttpsPreview) { 44446 } else { 44444 }
$taskListeners = @(
    [pscustomobject]@{ Port=$taskWebPort; Address=$taskWebBind },
    [pscustomobject]@{ Port=$taskApiPort; Address='127.0.0.1' },
    [pscustomobject]@{ Port=$taskWorldPort; Address='127.0.0.1' }
)
if ($TailnetHttpsPreview) {
    $taskListeners += @(
        [pscustomobject]@{ Port=$taskApiManagementPort; Address='127.0.0.1' },
        [pscustomobject]@{ Port=$taskWorldManagementPort; Address='127.0.0.1' },
        [pscustomobject]@{ Port=$taskMediaControlPort; Address='127.0.0.1' },
        [pscustomobject]@{ Port=$taskMediaRtcPort; Address=$taskTailnetAddress }
    )
}
foreach ($taskListener in $taskListeners) {
    $taskConflicts = Get-NetTCPConnection -State Listen -LocalPort $taskListener.Port -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -in @($taskListener.Address, '::', '0.0.0.0') }
    if ($taskConflicts) { throw "Address $($taskListener.Address):$($taskListener.Port) is in use. Stop the existing HUFS Town process first; unrelated processes are not stopped." }
    if ($TailnetHttpsPreview -and $taskListener.Port -eq $taskMediaRtcPort) {
        $taskUdpConflicts = Get-NetUDPEndpoint -LocalPort $taskListener.Port -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -in @($taskListener.Address, '::', '0.0.0.0') }
        if ($taskUdpConflicts) { throw "UDP $($taskListener.Address):$($taskListener.Port) is in use. The isolated media preview will not take over an unrelated listener." }
    }
}
$taskJdkCandidates = @($env:JAVA_HOME) + @(Get-ChildItem -LiteralPath "$env:USERPROFILE/.jdks" -Directory -ErrorAction SilentlyContinue | Where-Object Name -Match '21' | ForEach-Object FullName)
$taskJdk = $taskJdkCandidates | Where-Object { $_ -and (Test-Path -LiteralPath "$_/bin/java.exe") -and (Get-Content -LiteralPath "$_/release" -ErrorAction SilentlyContinue | Select-String 'JAVA_VERSION="21\.') } | Select-Object -First 1
if (-not $taskJdk) { throw 'JDK 21 is required. Set JAVA_HOME to a JDK 21 installation.' }
if (-not (Test-Path -LiteralPath "$taskFrontend/node_modules/vite/bin/vite.js")) { throw 'Run pnpm install in the frontend directory first.' }
if ($Profile -eq 'local' -and -not $env:DB_PASSWORD) { throw 'Copy infra/.env.example to infra/.env and start Docker Compose, or set DB_PASSWORD. Use -Profile preview explicitly for a no-database preview.' }
if ($TailnetHttpsPreview -and -not (Test-Path -LiteralPath "$taskBackend/.env")) { throw 'Secure tailnet media preview requires backend/.env; create it from .env.example first.' }
if (-not $SkipBuild) {
    & "$PSScriptRoot/gradle.ps1" :apps:api:bootJar :apps:world:bootJar --console=plain
    if ($LASTEXITCODE -ne 0) { throw 'Backend build failed.' }
}
$taskStarted = [System.Collections.Generic.List[object]]::new()
$taskMediaStarted = $false
$taskServeStarted = $false
function Start-TownProcess($Name, $Executable, $Arguments, $WorkingDirectory, $Port) {
    $process = Start-Process -FilePath $Executable -ArgumentList $Arguments -WorkingDirectory $WorkingDirectory -WindowStyle Hidden -PassThru -RedirectStandardOutput "$taskRuntime/$Name.log" -RedirectStandardError "$taskRuntime/$Name.error.log"
    $taskStarted.Add([pscustomobject]@{ Name=$Name; Id=$process.Id; StartTicks=$process.StartTime.ToUniversalTime().Ticks.ToString(); Port=$Port })
    ConvertTo-Json -InputObject @($taskStarted.ToArray()) | Set-Content -LiteralPath $taskStateFile -Encoding utf8
}
try {
    if ($TailnetHttpsPreview) {
        $taskTailnetState = [pscustomobject]@{
            Origin=$taskWebOrigin
            TailnetAddress=$taskTailnetAddress
            MediaControlPort=$taskMediaControlPort
            MediaRtcPort=$taskMediaRtcPort
            BaselineFingerprint=(Get-TownFingerprint $taskServeConfig.Text)
            ConfigFingerprint=''
        }
        $taskTailnetState | ConvertTo-Json | Set-Content -LiteralPath $taskTailnetStateFile -Encoding utf8
        & "$PSScriptRoot/media.ps1" start -TailnetAddress $taskTailnetAddress -ControlHostPort $taskMediaControlPort -RtcPort $taskMediaRtcPort -DedicatedTailnetPreview
        if ($LASTEXITCODE -ne 0) { throw 'The isolated tailnet media service could not start.' }
        $taskMediaStarted = $true
        if (-not $env:MEDIA_CONTROL_TOKEN) {
            foreach ($taskLine in Get-Content -LiteralPath "$taskBackend/.env" -Encoding utf8) {
                if ($taskLine.Trim() -match '^MEDIA_CONTROL_TOKEN=(.*)$') {
                    $taskToken = $Matches[1].Trim()
                    if ($taskToken.Length -ge 2 -and (($taskToken.StartsWith('"') -and $taskToken.EndsWith('"')) -or ($taskToken.StartsWith("'") -and $taskToken.EndsWith("'")))) { $taskToken=$taskToken.Substring(1,$taskToken.Length-2) }
                    if ($taskToken) { $env:MEDIA_CONTROL_TOKEN=$taskToken }
                    break
                }
            }
        }
        if ($env:MEDIA_CONTROL_TOKEN.Length -lt 32) { throw 'Secure tailnet media preview requires a valid media control token in backend/.env.' }
    }
    Start-TownProcess 'api' "$taskJdk/bin/java.exe" @('-Duser.timezone=UTC', '-jar', "`"$taskRoot/.build/backend/apps/api/libs/api-0.1.0-SNAPSHOT.jar`"", "--spring.profiles.active=$Profile", "--server.port=$taskApiPort", "--management.server.port=$taskApiManagementPort") $taskBackend $taskApiPort
    Start-TownProcess 'world' "$taskJdk/bin/java.exe" @('-Duser.timezone=UTC', '-jar', "`"$taskRoot/.build/backend/apps/world/libs/world-0.1.0-SNAPSHOT.jar`"", "--spring.profiles.active=$Profile", "--server.port=$taskWorldPort", "--management.server.port=$taskWorldManagementPort") $taskBackend $taskWorldPort
    Start-TownProcess 'web' (Get-Command node).Source @("`"$taskFrontend/node_modules/vite/bin/vite.js`"", '--host', $taskWebBind, '--port', $taskWebPort) $taskFrontend $taskWebPort
    $ready = $false
    for ($attempt=0; $attempt -lt 40; $attempt++) {
        if ($taskStarted | Where-Object { -not (Get-OwnedProcess $_) }) { throw "A server stopped. Read logs in $taskRuntime" }
        try {
            Invoke-RestMethod "http://127.0.0.1:$taskApiManagementPort/actuator/health" -TimeoutSec 1 | Out-Null
            Invoke-RestMethod "http://127.0.0.1:$taskWorldManagementPort/actuator/health" -TimeoutSec 1 | Out-Null
            $taskWebHealthUri = if ($TailnetHttpsPreview) { "http://127.0.0.1:$taskWebPort/" } else { "$taskWebOrigin/" }
            Invoke-WebRequest $taskWebHealthUri -TimeoutSec 1 | Out-Null
            $ready = $true; break
        } catch { Start-Sleep -Milliseconds 500 }
    }
    if (-not $ready) { throw "Readiness check timed out. Read logs in $taskRuntime" }
    if ($TailnetHttpsPreview) {
        & $taskTailscale.Source serve --bg --https=443 "http://127.0.0.1:$taskWebPort"
        if ($LASTEXITCODE -ne 0) { throw 'Tailscale HTTPS Serve could not start. Follow any HTTPS activation prompt, then run the secure preview again.' }
        $taskServeStarted = $true
        $taskStartedConfig = Get-TailscaleServeConfig
        if (-not $taskStartedConfig.Configured) { throw 'Tailscale Serve did not create the expected HTTPS route.' }
        $taskTailnetState.ConfigFingerprint = Get-TownFingerprint $taskStartedConfig.Text
        $taskTailnetState | ConvertTo-Json | Set-Content -LiteralPath $taskTailnetStateFile -Encoding utf8
        $taskHttpsReady = $false
        for ($attempt=0; $attempt -lt 30; $attempt++) {
            try {
                Invoke-WebRequest "$taskWebOrigin/" -TimeoutSec 2 | Out-Null
                $taskHttpsReady = $true; break
            } catch { Start-Sleep -Seconds 1 }
        }
        if (-not $taskHttpsReady) { throw 'Tailnet HTTPS did not become ready. Complete any HTTPS activation prompt and check the Tailscale Serve status.' }
    }
    Write-Output "HUFS Town ready: $taskWebOrigin/ (API profile: $Profile)"
} catch {
    if ($taskServeStarted) {
        try { [void](Remove-OwnedTailnetServe $taskTailnetState) }
        catch { Write-Warning 'Could not automatically remove the temporary Tailscale Serve route.' }
    }
    foreach ($entry in $taskStarted) { $owned = Get-OwnedProcess $entry; if ($owned) { Stop-Process -InputObject $owned } }
    '[]' | Set-Content -LiteralPath $taskStateFile -Encoding utf8
    if ($taskMediaStarted) {
        & "$PSScriptRoot/media.ps1" stop -TailnetAddress $taskTailnetAddress -ControlHostPort $taskMediaControlPort -RtcPort $taskMediaRtcPort -DedicatedTailnetPreview
        if ($LASTEXITCODE -ne 0) { Write-Warning 'Could not automatically stop the isolated tailnet media service.' }
    }
    throw
}
