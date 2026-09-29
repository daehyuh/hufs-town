param(
    [uri]$BaseUri = [uri]'https://town.gdgoc.com',
    [ValidateRange(1, 60)][int]$TimeoutSeconds = 15,
    [ValidateRange(1, 5000)][int]$ExpectedSpaceCapacity = 100,
    [string]$ExpectedPageTitle = 'GDG HUFS 훕스타운'
)

$ErrorActionPreference = 'Stop'
$origin = $BaseUri.GetLeftPart([System.UriPartial]::Authority)
$webSocketUri = "$origin/world/socket"

function Get-JsonEndpoint([string]$Path) {
    $response = Invoke-WebRequest -Uri "$origin$Path" -TimeoutSec $TimeoutSeconds
    if ($response.StatusCode -ne 200) {
        throw "Expected HTTP 200 from $Path; received $($response.StatusCode)."
    }
    return $response.Content | ConvertFrom-Json
}

function Get-WebSocketHandshakeStatus([switch]$IncludeOrigin) {
    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    if (-not $curl) {
        throw 'curl.exe is required to verify the WebSocket upgrade boundary.'
    }

    $arguments = @(
        '--silent', '--show-error', '--max-time', "$TimeoutSeconds",
        '--output', 'NUL', '--write-out', '%{http_code}',
        '--header', 'Connection: Upgrade',
        '--header', 'Upgrade: websocket',
        '--header', 'Sec-WebSocket-Version: 13',
        '--header', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=='
    )
    if ($IncludeOrigin) {
        $arguments += @('--header', "Origin: $origin")
    }

    $status = & $curl.Source @arguments $webSocketUri
    if ($LASTEXITCODE -ne 0) {
        throw "WebSocket handshake probe failed (curl exit $LASTEXITCODE)."
    }
    return [int]$status
}

$homeResponse = Invoke-WebRequest -Uri $origin -TimeoutSec $TimeoutSeconds
if ($homeResponse.StatusCode -ne 200) {
    throw "Expected HTTP 200 from the website; received $($homeResponse.StatusCode)."
}
$pageTitle = [regex]::Match(
    $homeResponse.Content,
    '<title>(.*?)</title>',
    [System.Text.RegularExpressions.RegexOptions]::Singleline
).Groups[1].Value.Trim()
$pageTitleMatches = $pageTitle -ceq $ExpectedPageTitle

$authResponse = Invoke-WebRequest -Uri "$origin/api/v1/auth/config" -TimeoutSec $TimeoutSeconds
if ($authResponse.StatusCode -ne 200) {
    throw "Expected HTTP 200 from the auth configuration endpoint; received $($authResponse.StatusCode)."
}
$authConfig = $authResponse.Content | ConvertFrom-Json
if ($authConfig.configured -ne $true) {
    throw 'HUFS SSO is not configured on this deployment.'
}

$bootstrap = Get-JsonEndpoint '/api/v1/bootstrap'
if ($bootstrap.space.capacity -ne $ExpectedSpaceCapacity) {
    throw "Expected space capacity $ExpectedSpaceCapacity; received $($bootstrap.space.capacity)."
}
if ($bootstrap.features.running -ne $true -or
    $bootstrap.features.ssoLogin -ne $true -or
    $bootstrap.features.media -ne $true) {
    throw 'The deployment does not report the expected running, SSO, and media features.'
}

$missingOriginStatus = Get-WebSocketHandshakeStatus
$trustedOriginNoSessionStatus = Get-WebSocketHandshakeStatus -IncludeOrigin
if ($missingOriginStatus -ne 403) {
    throw "Expected WebSocket request without Origin to return 403; received $missingOriginStatus."
}
if ($trustedOriginNoSessionStatus -ne 401) {
    throw "Expected unauthenticated WebSocket request with the trusted Origin to return 401; received $trustedOriginNoSessionStatus."
}

$result = [pscustomobject]@{
    status = if ($pageTitleMatches) { 'PASS' } else { 'FAIL' }
    origin = $origin
    websiteHttpStatus = [int]$homeResponse.StatusCode
    pageTitle = $pageTitle
    expectedPageTitle = $ExpectedPageTitle
    pageTitleMatches = $pageTitleMatches
    authConfigHttpStatus = [int]$authResponse.StatusCode
    ssoConfigured = $authConfig.configured
    bootstrapHttpStatus = 200
    spaceCapacity = $bootstrap.space.capacity
    running = $bootstrap.features.running
    ssoLogin = $bootstrap.features.ssoLogin
    media = $bootstrap.features.media
    webSocketWithoutOriginStatus = $missingOriginStatus
    webSocketTrustedOriginWithoutSessionStatus = $trustedOriginNoSessionStatus
}
$result | ConvertTo-Json -Depth 4
if (-not $pageTitleMatches) {
    throw "The public page title does not match the expected brand title '$ExpectedPageTitle'."
}
