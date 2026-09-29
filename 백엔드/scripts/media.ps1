param(
    [ValidateSet('start','stop','status','test')][string]$Action='start',
    [string]$TailnetAddress,
    [ValidateRange(1,65535)][int]$ControlHostPort=18083,
    [ValidateRange(1,65535)][int]$RtcPort=44445,
    [switch]$DedicatedTailnetPreview
)
$ErrorActionPreference='Stop'
$taskBackend=Split-Path $PSScriptRoot -Parent
$taskEnv=Join-Path $taskBackend '.env'
$taskCompose=Join-Path $taskBackend 'infra/media.compose.yaml'
$taskProjectName='hufs-town-media'
if ($DedicatedTailnetPreview) {
    if ($Action -notin @('start','stop','status','test')) { throw 'Unsupported media action.' }
    if (-not $TailnetAddress) { throw '-DedicatedTailnetPreview requires -TailnetAddress.' }
    $taskAddress=$null
    if (-not [System.Net.IPAddress]::TryParse($TailnetAddress,[ref]$taskAddress)) { throw 'Tailnet address must be an IPv4 address.' }
    $taskAddressBytes=$taskAddress.GetAddressBytes()
    if ($taskAddress.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork -or $taskAddressBytes[0] -ne 100 -or $taskAddressBytes[1] -lt 64 -or $taskAddressBytes[1] -gt 127) { throw 'Tailnet address must be in 100.64.0.0/10.' }
    $TailnetAddress=$taskAddress.ToString()
    $taskProjectName='hufs-town-tailnet-preview'
}
function Invoke-TownMediaCompose([string[]]$Arguments) {
    $taskComposeArgs=@('--project-name',$taskProjectName,'--env-file',$taskEnv,'-f',$taskCompose)+$Arguments
    & docker compose @taskComposeArgs
    if ($LASTEXITCODE -ne 0) { throw "Media Compose action failed ($LASTEXITCODE)." }
}
if($Action -eq 'start') {
    if(-not(Test-Path -LiteralPath $taskEnv)){throw 'Create backend/.env from .env.example first.'}
    $taskContent=[IO.File]::ReadAllText($taskEnv)
    if($taskContent -notmatch '(?m)^MEDIA_CONTROL_TOKEN=\S{32,}\s*$') {
        if($taskContent -match '(?m)^MEDIA_CONTROL_TOKEN=\S+') {throw 'MEDIA_CONTROL_TOKEN must contain at least 32 characters.'}
        $taskToken=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
        if($taskContent -match '(?m)^MEDIA_CONTROL_TOKEN=.*$'){$taskContent=[regex]::Replace($taskContent,'(?m)^MEDIA_CONTROL_TOKEN=.*$',"MEDIA_CONTROL_TOKEN=$taskToken")}
        else{$taskContent+="`nMEDIA_CONTROL_TOKEN=$taskToken`n"}
    }
    $taskPersistedSettings=if($DedicatedTailnetPreview){@()}else{@(@('TOWN_MEDIA_ENABLED','true'),@('MEDIA_CONTROL_URL','http://127.0.0.1:18082'))}
    foreach($entry in $taskPersistedSettings) {
        $taskPattern='(?m)^'+$entry[0]+'=.*$';$taskSetting=$entry[0]+'='+$entry[1]
        if($taskContent -match $taskPattern){$taskContent=[regex]::Replace($taskContent,$taskPattern,$taskSetting)}else{$taskContent+="`n$taskSetting`n"}
    }
    [IO.File]::WriteAllText($taskEnv,$taskContent,[Text.UTF8Encoding]::new($false))
    if($DedicatedTailnetPreview) {
        $env:MEDIA_ANNOUNCED_ADDRESS=$TailnetAddress
        $env:MEDIA_RTC_BIND_ADDRESS=$TailnetAddress
        $env:MEDIA_RTC_PORT="$RtcPort"
        $env:MEDIA_CONTROL_BIND_ADDRESS='127.0.0.1'
        $env:MEDIA_CONTROL_HOST_PORT="$ControlHostPort"
    }
    Invoke-TownMediaCompose @('up','-d','--build','--wait')
} elseif($Action -eq 'stop') {
    if($DedicatedTailnetPreview){Invoke-TownMediaCompose @('down','--remove-orphans')}
    else {Invoke-TownMediaCompose @('stop')}
} elseif($Action -eq 'test') {
    Invoke-TownMediaCompose @('exec','-T','media','npm','test')
} else {
    Invoke-TownMediaCompose @('ps')
}
